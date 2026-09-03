import { db } from "@cap/database";
import { type MeetingBotStatus, meetingBots } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { syncCalendarStatus } from "@/lib/recall/calendars";
import { syncCalendarEventsWorkflow } from "@/workflows/recall-calendar-sync";
import {
	completeRecallTranscriptWorkflow,
	failRecallTranscriptWorkflow,
	importRecallRecordingWorkflow,
} from "@/workflows/recall-meeting";
import { applyBotStatusEvent } from "./bots";

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

	const alreadyStarted = rows.find((row) =>
		IMPORT_STARTED_STATUSES.includes(row.status),
	);
	const eligible = rows
		.filter(
			(row) =>
				!TERMINAL_STATUSES.includes(row.status) &&
				!IMPORT_STARTED_STATUSES.includes(row.status),
		)
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

	const primary =
		alreadyStarted ??
		(preferred && eligible.some((row) => row.id === preferred.id)
			? preferred
			: undefined) ??
		eligible[0];
	if (!primary) return;

	if (!IMPORT_STARTED_STATUSES.includes(primary.status)) {
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
		if (IMPORT_STARTED_STATUSES.includes(row.status)) continue;
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

async function handleTranscriptDone(data: unknown): Promise<void> {
	const transcript = asRecord(data, "transcript");
	const transcriptId = asString(transcript?.id);
	if (!transcriptId) {
		console.info("[recall-webhook] ignored transcript.done", {
			reason: "missing-fields",
		});
		return;
	}

	const [row] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.recallTranscriptId, transcriptId))
		.limit(1);
	if (!row) {
		console.info("[recall-webhook] transcript.done with no row", {
			transcriptId,
		});
		return;
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
	const [row] = transcriptId
		? await db()
				.select()
				.from(meetingBots)
				.where(eq(meetingBots.recallTranscriptId, transcriptId))
				.limit(1)
		: [];

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
		default:
			console.info("[recall-webhook] ignored event", { event });
	}
}
