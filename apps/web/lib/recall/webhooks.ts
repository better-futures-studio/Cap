import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	type MeetingBotStatus,
	meetingBots,
	organizations,
	slackHuddleTeams,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Organisation } from "@cap/web-domain";
import { and, eq, notInArray } from "drizzle-orm";
import { start } from "workflow/api";
import { syncCalendarStatus } from "@/lib/recall/calendars";
import { syncCalendarEventsWorkflow } from "@/workflows/recall-calendar-sync";
import {
	completeRecallTranscriptWorkflow,
	failRecallTranscriptWorkflow,
	importRecallRecordingWorkflow,
} from "@/workflows/recall-meeting";
import { applyBotStatusEvent } from "./bots";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";
import { shouldStartTranscriptCompletion } from "./transcript-reuse";

const TERMINAL_STATUSES: MeetingBotStatus[] = [
	"fatal",
	"failed",
	"cancelled",
	"opted_out",
	"complete",
];

const IMPORT_STARTED_STATUSES: MeetingBotStatus[] = [
	"importing",
	"transcribing",
	"complete",
];

export type RecallWebhookPayload = {
	event: string;
	data: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(
	value: unknown,
	key: string,
): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const nested = value[key];
	return isRecord(nested) ? nested : undefined;
}

function sharedSubCode(meetingBotId: string): string {
	return `shared:${meetingBotId}`;
}

async function handleBotEvent(data: unknown): Promise<void> {
	const bot = asRecord(data, "bot");
	const status = asRecord(data, "data");
	const recallBotId = asString(bot?.id);
	const code = asString(status?.code);
	if (!recallBotId || !code) {
		console.info("[recall-webhook] ignored bot event", {
			reason: "missing-fields",
		});
		return;
	}

	const subCode = asString(status?.sub_code) ?? null;
	const updatedAt = asString(status?.updated_at);
	await applyBotStatusEvent({
		recallBotId,
		code,
		subCode,
		updatedAt,
	});
}

async function handleRecordingDone(data: unknown): Promise<void> {
	const bot = asRecord(data, "bot");
	const recording = asRecord(data, "recording");
	const recallBotId = asString(bot?.id);
	const recordingId = asString(recording?.id);
	if (!recallBotId || !recordingId) {
		console.info("[recall-webhook] ignored recording.done", {
			reason: "missing-fields",
		});
		return;
	}

	const rows = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.recallBotId, recallBotId));
	if (rows.length === 0) {
		console.info("[recall-webhook] recording.done with no rows", {
			recallBotId,
		});
		return;
	}

	const calendarEvent = asRecord(data, "calendar_event");
	const calendarEventId = asString(calendarEvent?.id);
	const preferred = calendarEventId
		? rows.find((row) => row.calendarEventId === calendarEventId)
		: undefined;

	const importStarted = (row: (typeof rows)[number]) =>
		row.recallRecordingId !== null || row.videoId !== null;
	const alreadyStarted = rows.find(importStarted);
	const eligible = rows
		.filter(
			(row) => !TERMINAL_STATUSES.includes(row.status) && !importStarted(row),
		)
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

	const primary =
		alreadyStarted ??
		(preferred && eligible.some((row) => row.id === preferred.id)
			? preferred
			: undefined) ??
		eligible[0];
	if (!primary) return;

	if (!importStarted(primary)) {
		await start(importRecallRecordingWorkflow, [
			{ meetingBotId: primary.id, recordingId },
		]);
		console.info("[recall-webhook] started recording import", {
			meetingBotId: primary.id,
			recallBotId,
			recordingId,
		});
	}

	for (const row of rows) {
		if (row.id === primary.id) continue;
		if (TERMINAL_STATUSES.includes(row.status)) continue;
		if (importStarted(row)) continue;
		await db()
			.update(meetingBots)
			.set({ statusSubCode: sharedSubCode(primary.id) })
			.where(eq(meetingBots.id, row.id));
	}
}

async function handleRecordingFailed(data: unknown): Promise<void> {
	const bot = asRecord(data, "bot");
	const status = asRecord(data, "data");
	const recallBotId = asString(bot?.id);
	if (!recallBotId) {
		console.info("[recall-webhook] ignored recording.failed", {
			reason: "missing-fields",
		});
		return;
	}

	const subCode = asString(status?.sub_code);
	const rows = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.recallBotId, recallBotId));

	for (const row of rows) {
		if (TERMINAL_STATUSES.includes(row.status)) continue;
		if (row.status === "importing" || row.status === "transcribing") continue;
		await db()
			.update(meetingBots)
			.set({
				status: "failed",
				statusSubCode: subCode ?? null,
				errorMessage: subCode || "Recording failed",
			})
			.where(eq(meetingBots.id, row.id));
	}
}

function transcriptStatusCode(data: unknown): string | undefined {
	const status = asRecord(data, "data");
	const fromEvent = asString(status?.code);
	if (fromEvent) return fromEvent;
	const transcript = asRecord(data, "transcript");
	return asString(asRecord(transcript, "status")?.code);
}

async function findMeetingBotForTranscript(
	data: unknown,
	transcriptId: string,
) {
	const [byTranscript] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.recallTranscriptId, transcriptId))
		.limit(1);
	if (byTranscript) return byTranscript;

	const recordingId = asString(asRecord(data, "recording")?.id);
	if (recordingId) {
		const [byRecording] = await db()
			.select()
			.from(meetingBots)
			.where(eq(meetingBots.recallRecordingId, recordingId))
			.limit(1);
		if (byRecording) return byRecording;
	}

	const botId = asString(asRecord(data, "bot")?.id);
	if (!botId) return undefined;
	const rows = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.recallBotId, botId))
		.limit(20);
	return (
		rows.find(
			(row) =>
				IMPORT_STARTED_STATUSES.includes(row.status) &&
				row.status !== "complete",
		) ??
		rows.find((row) => !TERMINAL_STATUSES.includes(row.status)) ??
		rows[0]
	);
}

async function handleTranscriptDone(data: unknown): Promise<void> {
	const transcript = asRecord(data, "transcript");
	const transcriptId = asString(transcript?.id);
	if (!transcriptId) {
		console.info("[recall-webhook] ignored transcript.done", {
			reason: "missing-fields",
		});
		return;
	}

	const row = await findMeetingBotForTranscript(data, transcriptId);
	if (!row) {
		console.info("[recall-webhook] transcript.done with no row", {
			transcriptId,
		});
		return;
	}

	if (!row.videoId && !row.recallRecordingId) {
		await db()
			.update(meetingBots)
			.set({ recallTranscriptId: transcriptId })
			.where(eq(meetingBots.id, row.id));
		console.info("[recall-webhook] transcript.done before recording import", {
			meetingBotId: row.id,
			transcriptId,
		});
		return;
	}

	const incomingDone = transcriptStatusCode(data) !== "failed";
	const shouldAdopt =
		!row.recallTranscriptId ||
		(row.recallTranscriptId !== transcriptId && incomingDone);
	if (
		row.recallTranscriptId &&
		row.recallTranscriptId !== transcriptId &&
		!incomingDone
	) {
		return;
	}
	if (!shouldStartTranscriptCompletion(row, transcriptId)) {
		return;
	}

	if (shouldAdopt && row.recallTranscriptId !== transcriptId) {
		await db()
			.update(meetingBots)
			.set({
				recallTranscriptId: transcriptId,
				status: "transcribing",
			})
			.where(eq(meetingBots.id, row.id));
	} else if (row.status !== "transcribing" && row.status !== "complete") {
		await db()
			.update(meetingBots)
			.set({
				recallTranscriptId: transcriptId,
				status: "transcribing",
			})
			.where(eq(meetingBots.id, row.id));
	}

	await start(completeRecallTranscriptWorkflow, [
		{ meetingBotId: row.id, transcriptId },
	]);
	console.info("[recall-webhook] started transcript complete", {
		meetingBotId: row.id,
		transcriptId,
	});
}

async function handleTranscriptFailed(data: unknown): Promise<void> {
	const transcript = asRecord(data, "transcript");
	const transcriptId = asString(transcript?.id);
	const row = transcriptId
		? await findMeetingBotForTranscript(data, transcriptId)
		: undefined;

	if (!row) {
		console.info("[recall-webhook] transcript.failed with no row", {
			transcriptId,
		});
		return;
	}

	await start(failRecallTranscriptWorkflow, [{ meetingBotId: row.id }]);
	console.info("[recall-webhook] started transcript fallback", {
		meetingBotId: row.id,
		transcriptId,
	});
}

async function handleCalendarUpdate(data: unknown): Promise<void> {
	const recallCalendarId = isRecord(data)
		? asString(data.calendar_id)
		: undefined;
	if (!recallCalendarId) {
		console.info("[recall-webhook] ignored calendar.update", {
			reason: "missing-fields",
		});
		return;
	}
	await syncCalendarStatus(recallCalendarId);
}

async function handleCalendarSyncEvents(data: unknown): Promise<void> {
	const recallCalendarId = isRecord(data)
		? asString(data.calendar_id)
		: undefined;
	if (!recallCalendarId) {
		console.info("[recall-webhook] ignored calendar.sync_events", {
			reason: "missing-fields",
		});
		return;
	}

	const lastUpdated = isRecord(data) ? data.last_updated_ts : undefined;
	const updatedAtGte =
		typeof lastUpdated === "string"
			? lastUpdated
			: typeof lastUpdated === "number"
				? new Date(lastUpdated).toISOString()
				: new Date(0).toISOString();

	await start(syncCalendarEventsWorkflow, [{ recallCalendarId, updatedAtGte }]);
	console.info("[recall-webhook] started calendar sync", { recallCalendarId });
}

async function resolveDefaultOrgId(): Promise<Organisation.OrganisationId | null> {
	const configured = serverEnv().CAP_DEFAULT_ORG_ID;
	if (configured) return Organisation.OrganisationId.make(configured);
	const [org] = await db()
		.select({ id: organizations.id })
		.from(organizations)
		.limit(1);
	return org?.id ?? null;
}

function slackTeamIdFrom(data: unknown): string | undefined {
	return asString(asRecord(data, "slack_team")?.id);
}

async function upsertSlackHuddleTeam({
	recallSlackTeamId,
	botName,
	status,
}: {
	recallSlackTeamId: string;
	botName: string;
	status: "invited" | "active" | "revoked";
}): Promise<void> {
	const [existing] = await db()
		.select({ id: slackHuddleTeams.id })
		.from(slackHuddleTeams)
		.where(eq(slackHuddleTeams.recallSlackTeamId, recallSlackTeamId))
		.limit(1);
	if (existing) {
		await db()
			.update(slackHuddleTeams)
			.set({ status, botName })
			.where(eq(slackHuddleTeams.id, existing.id));
		return;
	}

	const orgId = await resolveDefaultOrgId();
	if (!orgId) {
		console.info("[recall-webhook] slack team has no org", {
			recallSlackTeamId,
		});
		return;
	}

	await db().insert(slackHuddleTeams).values({
		id: nanoId(),
		orgId,
		recallSlackTeamId,
		botName,
		status,
	});
}

async function handleSlackTeamInvited(data: unknown): Promise<void> {
	const recallSlackTeamId = slackTeamIdFrom(data);
	if (!recallSlackTeamId) {
		console.info("[recall-webhook] ignored slack_team.invited", {
			reason: "missing-fields",
		});
		return;
	}

	const config = getRecallConfig();
	const botName = config?.botName ?? DEFAULT_BOT_NAME;
	await upsertSlackHuddleTeam({
		recallSlackTeamId,
		botName,
		status: "invited",
	});

	if (!config) {
		console.info(
			"[recall-webhook] slack team invited but Recall not configured",
		);
		return;
	}

	try {
		await getDefaultRecallClient().activateSlackTeam(recallSlackTeamId, {
			botName: config.botName,
		});
		await db()
			.update(slackHuddleTeams)
			.set({ status: "active" })
			.where(eq(slackHuddleTeams.recallSlackTeamId, recallSlackTeamId));
	} catch (error) {
		console.error("[recall-webhook] activate slack team failed", {
			recallSlackTeamId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

async function handleSlackTeamActive(data: unknown): Promise<void> {
	const recallSlackTeamId = slackTeamIdFrom(data);
	if (!recallSlackTeamId) {
		console.info("[recall-webhook] ignored slack_team.active", {
			reason: "missing-fields",
		});
		return;
	}

	await db()
		.update(slackHuddleTeams)
		.set({ status: "active" })
		.where(eq(slackHuddleTeams.recallSlackTeamId, recallSlackTeamId));
}

async function handleSlackTeamAccessRevoked(data: unknown): Promise<void> {
	const recallSlackTeamId = slackTeamIdFrom(data);
	if (!recallSlackTeamId) {
		console.info("[recall-webhook] ignored slack_team.access_revoked", {
			reason: "missing-fields",
		});
		return;
	}

	await db()
		.update(slackHuddleTeams)
		.set({ status: "revoked" })
		.where(eq(slackHuddleTeams.recallSlackTeamId, recallSlackTeamId));

	await db()
		.update(meetingBots)
		.set({ status: "cancelled" })
		.where(
			and(
				eq(meetingBots.slackTeamId, recallSlackTeamId),
				notInArray(meetingBots.status, TERMINAL_STATUSES),
			),
		);
}

export async function dispatchRecallWebhook(
	payload: RecallWebhookPayload,
): Promise<void> {
	const { event, data } = payload;

	if (event.startsWith("bot.")) {
		await handleBotEvent(data);
		return;
	}

	switch (event) {
		case "recording.done":
			await handleRecordingDone(data);
			return;
		case "recording.failed":
			await handleRecordingFailed(data);
			return;
		case "transcript.done":
			await handleTranscriptDone(data);
			return;
		case "transcript.failed":
			await handleTranscriptFailed(data);
			return;
		case "calendar.update":
			await handleCalendarUpdate(data);
			return;
		case "calendar.sync_events":
			await handleCalendarSyncEvents(data);
			return;
		case "slack_team.invited":
			await handleSlackTeamInvited(data);
			return;
		case "slack_team.active":
			await handleSlackTeamActive(data);
			return;
		case "slack_team.access_revoked":
			await handleSlackTeamAccessRevoked(data);
			return;
		default:
			console.info("[recall-webhook] ignored event", { event });
	}
}
