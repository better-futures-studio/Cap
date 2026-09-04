import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	type MeetingBotStatus,
	meetingBots,
	organizations,
	slackHuddleTeams,
} from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull, lt, notInArray, or } from "drizzle-orm";
import { buildJoinChatMessage } from "./bot-chat";
import { loadBotVideoOutput } from "./bot-image";
import { getUserCalendar } from "./calendars";
import {
	RecallApiError,
	type RecallAutomaticVideoOutput,
	type RecallCalendarEvent,
	type RecallClient,
} from "./client";
import { botImageUrlForOrg, DEFAULT_BOT_NAME, getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";
import {
	buildLiveRecordingConfig,
	withRecordingRetention,
} from "./realtime-config";

export const SUPPORTED_MEETING_HOSTS = [
	/zoom\.us$/,
	/meet\.google\.com$/,
	/teams\.microsoft\.com$/,
	/teams\.live\.com$/,
	/webex\.com$/,
];

const TERMINAL_STATUSES: MeetingBotStatus[] = [
	"fatal",
	"failed",
	"cancelled",
	"opted_out",
	"complete",
];

const PAST_DONE_STATUSES: MeetingBotStatus[] = ["importing", "transcribing"];

const CANCELLABLE_STATUSES: MeetingBotStatus[] = ["scheduling", "scheduled"];

const BOT_STATUS_BY_CODE: Record<string, MeetingBotStatus> = {
	ready: "scheduled",
	joining_call: "joining_call",
	in_waiting_room: "in_waiting_room",
	in_call_not_recording: "in_call_not_recording",
	in_call_recording: "in_call_recording",
	call_ended: "call_ended",
	done: "done",
	fatal: "fatal",
};

const JOIN_AT_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const JOIN_AT_PAST_MS = 5 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 2 * 60 * 60 * 1000;
const STALE_SCHEDULING_MS = 10 * 60 * 1000;

export type MeetingPlatform =
	| "zoom"
	| "google_meet"
	| "microsoft_teams"
	| "webex";

function getAffectedRows(result: unknown): number {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

function platformForHost(hostname: string): MeetingPlatform | null {
	const host = hostname.toLowerCase();
	if (SUPPORTED_MEETING_HOSTS[0]?.test(host)) return "zoom";
	if (SUPPORTED_MEETING_HOSTS[1]?.test(host)) return "google_meet";
	if (
		SUPPORTED_MEETING_HOSTS[2]?.test(host) ||
		SUPPORTED_MEETING_HOSTS[3]?.test(host)
	) {
		return "microsoft_teams";
	}
	if (SUPPORTED_MEETING_HOSTS[4]?.test(host)) return "webex";
	return null;
}

function sharedSubCode(meetingBotId: string): string {
	return `shared:${meetingBotId}`;
}

function isSharedSubCode(value: string | null | undefined): boolean {
	return !!value?.startsWith("shared:");
}

function sharedPrimaryId(row: {
	id: string;
	statusSubCode: string | null;
}): string {
	if (row.statusSubCode?.startsWith("shared:")) {
		return row.statusSubCode.slice("shared:".length);
	}
	return row.id;
}

export function normalizeMeetingUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		parsed.search = "";
		parsed.hostname = parsed.hostname.toLowerCase();
		parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return url.trim().toLowerCase().replace(/\/+$/, "");
	}
}

function eventSummary(event: RecallCalendarEvent): string | null {
	const raw = event.raw;
	if (raw && typeof raw === "object" && "summary" in raw) {
		const summary = (raw as { summary?: unknown }).summary;
		return typeof summary === "string" && summary.trim()
			? summary.trim()
			: null;
	}
	return null;
}

async function lookupCalendarMatchForManualBot({
	orgId,
	userId,
	meetingUrl,
	now,
	client,
}: {
	orgId: Organisation.OrganisationId;
	userId: User.UserId;
	meetingUrl: string;
	now: Date;
	client: RecallClient;
}): Promise<{ title: string | null; calendarEventId: string | null }> {
	try {
		const calendar = await getUserCalendar({ orgId, userId });
		if (!calendar || calendar.status !== "connected") {
			return { title: null, calendarEventId: null };
		}
		const windowMs = 2 * 60 * 60 * 1000;
		const events = await client.listCalendarEvents({
			calendarId: calendar.recallCalendarId,
			startTimeGte: new Date(now.getTime() - windowMs).toISOString(),
			startTimeLte: new Date(now.getTime() + windowMs).toISOString(),
			isDeleted: false,
		});
		const normalized = normalizeMeetingUrl(meetingUrl);
		const match = events.find(
			(event) =>
				event.meeting_url &&
				normalizeMeetingUrl(event.meeting_url) === normalized,
		);
		if (!match) return { title: null, calendarEventId: null };

		const [existing] = await db()
			.select({ id: meetingBots.id })
			.from(meetingBots)
			.where(eq(meetingBots.calendarEventId, match.id))
			.limit(1);
		return {
			title: eventSummary(match),
			calendarEventId: existing ? null : match.id,
		};
	} catch {
		return { title: null, calendarEventId: null };
	}
}

export function parseMeetingUrl(
	input: string,
): { url: string; platform: MeetingPlatform } | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const withProtocol = /^https?:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;

	let parsed: URL;
	try {
		parsed = new URL(withProtocol);
	} catch {
		return null;
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

	const platform = platformForHost(parsed.hostname);
	if (!platform) return null;

	parsed.username = "";
	parsed.password = "";
	return { url: parsed.toString(), platform };
}

type ScheduleManualMeetingBotInput = {
	orgId: Organisation.OrganisationId;
	userId: User.UserId;
	meetingUrl: string;
	joinAt?: Date;
	title?: string;
};

type MeetingBotDeps = {
	client?: RecallClient;
	now?: () => Date;
	botName?: string;
	botImage?: RecallAutomaticVideoOutput | null;
};

export async function scheduleManualMeetingBot(
	{ orgId, userId, meetingUrl, joinAt, title }: ScheduleManualMeetingBotInput,
	deps: MeetingBotDeps = {},
): Promise<{ id: string; status: MeetingBotStatus }> {
	const parsed = parseMeetingUrl(meetingUrl);
	if (!parsed) {
		throw new Error("Unsupported meeting URL");
	}

	const now = (deps.now ?? (() => new Date()))();
	const scheduledJoinAt = joinAt ?? now;
	const joinAtMs = scheduledJoinAt.getTime();
	if (!Number.isFinite(joinAtMs)) {
		throw new Error("Invalid join time");
	}
	if (joinAtMs - now.getTime() > JOIN_AT_MAX_MS) {
		throw new Error("Join time is more than 30 days ahead");
	}
	if (now.getTime() - joinAtMs > JOIN_AT_PAST_MS) {
		throw new Error("Join time is more than 5 minutes in the past");
	}

	const existing = await db()
		.select()
		.from(meetingBots)
		.where(
			and(
				eq(meetingBots.orgId, orgId),
				notInArray(meetingBots.status, TERMINAL_STATUSES),
			),
		)
		.limit(200);

	const normalizedUrl = normalizeMeetingUrl(parsed.url);
	const matches = existing.filter(
		(row) =>
			normalizeMeetingUrl(row.meetingUrl) === normalizedUrl &&
			Math.abs(row.joinAt.getTime() - scheduledJoinAt.getTime()) <
				DUPLICATE_WINDOW_MS,
	);
	const ownRow = matches.find((row) => row.ownerId === userId);
	if (ownRow) {
		return { id: ownRow.id, status: ownRow.status };
	}

	const sharedWith = matches[0];
	if (sharedWith) {
		const id = nanoId();
		await db()
			.insert(meetingBots)
			.values({
				id,
				orgId,
				ownerId: userId,
				source: "manual",
				meetingUrl: parsed.url,
				title: title?.trim() || sharedWith.title,
				joinAt: scheduledJoinAt,
				recallBotId: sharedWith.recallBotId,
				videoId: sharedWith.videoId,
				status: sharedWith.status,
				statusSubCode: sharedSubCode(sharedPrimaryId(sharedWith)),
			});
		return { id, status: sharedWith.status };
	}

	const client = deps.client ?? getDefaultRecallClient();
	let resolvedTitle = title?.trim() || null;
	let calendarEventId: string | null = null;
	if (!resolvedTitle) {
		const match = await lookupCalendarMatchForManualBot({
			orgId,
			userId,
			meetingUrl: parsed.url,
			now,
			client,
		});
		resolvedTitle = match.title;
		calendarEventId = match.calendarEventId;
	}

	const id = nanoId();
	await db().insert(meetingBots).values({
		id,
		orgId,
		ownerId: userId,
		source: "manual",
		meetingUrl: parsed.url,
		title: resolvedTitle,
		joinAt: scheduledJoinAt,
		calendarEventId,
		status: "scheduling",
	});
	const config = getRecallConfig();
	const botName = deps.botName ?? config?.botName ?? DEFAULT_BOT_NAME;
	const automaticVideoOutput =
		deps.botImage !== undefined
			? deps.botImage
			: config
				? await loadBotVideoOutput({
						botImageUrl: botImageUrlForOrg(config, orgId),
					})
				: null;

	try {
		const bot = await client.createBot({
			meetingUrl: parsed.url,
			joinAt: scheduledJoinAt.toISOString(),
			botName,
			metadata: { cap_meeting_bot_id: id, cap_org_id: orgId },
			joinChatMessage: buildJoinChatMessage(
				config ?? { botName, liveAgent: false, agentTrigger: "/nt" },
			),
			...(automaticVideoOutput ? { automaticVideoOutput } : {}),
			recordingConfig: withRecordingRetention(
				config,
				config ? buildLiveRecordingConfig(config) : undefined,
			),
		});
		await db()
			.update(meetingBots)
			.set({
				recallBotId: bot.id,
				status: "scheduled",
				errorMessage: null,
			})
			.where(eq(meetingBots.id, id));
		console.info("[recall] scheduled bot", {
			meetingBotId: id,
			recallBotId: bot.id,
			host: parsed.platform,
		});
		return { id, status: "scheduled" };
	} catch (error) {
		if (error instanceof RecallApiError) {
			await db()
				.update(meetingBots)
				.set({
					status: "failed",
					errorMessage: `Recall rejected the request (HTTP ${error.status})`,
				})
				.where(eq(meetingBots.id, id));
			console.error("[recall] create bot rejected", {
				meetingBotId: id,
				status: error.status,
			});
			return { id, status: "failed" };
		}
		console.error("[recall] create bot unconfirmed", { meetingBotId: id });
		return { id, status: "scheduling" };
	}
}

export async function cancelMeetingBot(
	{
		id,
		orgId,
		userId,
	}: {
		id: string;
		orgId: Organisation.OrganisationId;
		userId: User.UserId;
	},
	deps: { client?: RecallClient } = {},
): Promise<{ id: string; status: MeetingBotStatus }> {
	const [row] = await db()
		.select()
		.from(meetingBots)
		.where(
			and(
				eq(meetingBots.id, id),
				eq(meetingBots.orgId, orgId),
				eq(meetingBots.ownerId, userId),
			),
		)
		.limit(1);

	if (!row) {
		throw new Error("Meeting bot not found");
	}
	if (!CANCELLABLE_STATUSES.includes(row.status)) {
		throw new Error("Meeting bot cannot be cancelled");
	}

	if (isSharedSubCode(row.statusSubCode)) {
		await db()
			.update(meetingBots)
			.set({ status: "cancelled", errorMessage: null })
			.where(eq(meetingBots.id, id));
		console.info("[recall] cancelled shared bot row", { meetingBotId: id });
		return { id, status: "cancelled" };
	}

	const client = deps.client ?? getDefaultRecallClient();
	if (row.source === "calendar") {
		if (row.calendarEventId) {
			await client.removeCalendarEventBot(row.calendarEventId);
		}
		await db()
			.update(meetingBots)
			.set({ status: "opted_out", errorMessage: null })
			.where(eq(meetingBots.id, id));
		await db()
			.update(meetingBots)
			.set({ status: "opted_out", errorMessage: null })
			.where(eq(meetingBots.statusSubCode, sharedSubCode(id)));
		console.info("[recall] opted out calendar bot", { meetingBotId: id });
		return { id, status: "opted_out" };
	}

	if (row.recallBotId) {
		await client.deleteScheduledBot(row.recallBotId);
	}
	await db()
		.update(meetingBots)
		.set({ status: "cancelled", errorMessage: null })
		.where(eq(meetingBots.id, id));
	await db()
		.update(meetingBots)
		.set({ status: "cancelled", errorMessage: null })
		.where(eq(meetingBots.statusSubCode, sharedSubCode(id)));
	console.info("[recall] cancelled bot", {
		meetingBotId: id,
		recallBotId: row.recallBotId,
	});
	return { id, status: "cancelled" };
}

export async function applyBotStatusEvent({
	recallBotId,
	code,
	subCode,
	updatedAt,
}: {
	recallBotId: string;
	code: string;
	subCode?: string | null;
	updatedAt?: string | Date;
}): Promise<void> {
	const status = BOT_STATUS_BY_CODE[code];
	if (!status) {
		console.info("[recall] ignored bot status", { recallBotId, code });
		return;
	}

	const parsedEventAt = updatedAt ? new Date(updatedAt) : new Date();
	const eventAt = Number.isNaN(parsedEventAt.getTime())
		? new Date()
		: parsedEventAt;

	let rows = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.recallBotId, recallBotId))
		.limit(50);

	if (rows.length === 0) {
		await createSlackHuddleMeetingBot(recallBotId);
		rows = await db()
			.select()
			.from(meetingBots)
			.where(eq(meetingBots.recallBotId, recallBotId))
			.limit(50);
		if (rows.length === 0) return;
	}

	for (const row of rows) {
		if (
			TERMINAL_STATUSES.includes(row.status) ||
			PAST_DONE_STATUSES.includes(row.status)
		) {
			continue;
		}
		if (row.statusUpdatedAt && row.statusUpdatedAt >= eventAt) continue;

		// Svix delivers a bot's lifecycle events concurrently, so two handlers
		// can race on the same row; the WHERE clause makes the newest event win.
		await db()
			.update(meetingBots)
			.set({
				status,
				statusSubCode: isSharedSubCode(row.statusSubCode)
					? row.statusSubCode
					: (subCode ?? null),
				statusUpdatedAt: eventAt,
				...(status === "fatal"
					? { errorMessage: subCode || "Bot failed" }
					: {}),
			})
			.where(
				and(
					eq(meetingBots.id, row.id),
					or(
						isNull(meetingBots.statusUpdatedAt),
						lt(meetingBots.statusUpdatedAt, eventAt),
					),
				),
			);
	}
}

export async function reconcileStaleSchedulingRows(
	_client?: RecallClient,
): Promise<number> {
	const cutoff = new Date(Date.now() - STALE_SCHEDULING_MS);
	const result = await db()
		.update(meetingBots)
		.set({
			status: "failed",
			errorMessage: "Bot creation was not confirmed",
		})
		.where(
			and(
				eq(meetingBots.status, "scheduling"),
				lt(meetingBots.createdAt, cutoff),
			),
		);
	const count = getAffectedRows(result);
	if (count > 0) {
		console.info("[recall] marked stale scheduling rows failed", { count });
	}
	return count;
}

async function createSlackHuddleMeetingBot(recallBotId: string): Promise<void> {
	let slackTeamId: string | undefined;
	let title: string | null = null;
	let slackChannelId: string | null = null;
	try {
		const bot = await getDefaultRecallClient().getBot(recallBotId);
		slackTeamId = bot.slack_team?.id;
		title = bot.meeting_metadata?.title ?? null;
		slackChannelId = bot.meeting_metadata?.slack_channel_id ?? null;
	} catch (error) {
		console.info("[recall] could not fetch unknown bot", {
			recallBotId,
			status: error instanceof RecallApiError ? error.status : undefined,
		});
		return;
	}

	if (!slackTeamId) {
		console.info("[recall] ignored unknown bot without slack team", {
			recallBotId,
		});
		return;
	}

	const [team] = await db()
		.select()
		.from(slackHuddleTeams)
		.where(eq(slackHuddleTeams.recallSlackTeamId, slackTeamId))
		.limit(1);
	if (!team) {
		console.info("[recall] slack huddle bot has no matching team", {
			recallBotId,
			slackTeamId,
		});
		return;
	}

	const [org] = await db()
		.select({ ownerId: organizations.ownerId })
		.from(organizations)
		.where(eq(organizations.id, team.orgId))
		.limit(1);
	if (!org) {
		console.info("[recall] slack huddle team org missing", {
			orgId: team.orgId,
		});
		return;
	}

	await db()
		.insert(meetingBots)
		.values({
			id: nanoId(),
			orgId: team.orgId,
			ownerId: org.ownerId,
			source: "slack",
			meetingUrl: "",
			title: title ?? "Slack huddle",
			joinAt: new Date(),
			recallBotId,
			slackTeamId,
			slackChannelId,
			status: "scheduled",
		});
}
