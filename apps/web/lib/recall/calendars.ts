import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	type MeetingBotStatus,
	meetingBots,
	meetingCalendarSeriesRules,
	meetingCalendars,
} from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { BOT_AUTOMATIC_LEAVE } from "./automatic-leave";
import { buildJoinChatMessage } from "./bot-chat";
import { loadBotVideoOutput } from "./bot-image";
import {
	RecallApiError,
	type RecallAutomaticVideoOutput,
	type RecallCalendarEvent,
	type RecallClient,
} from "./client";
import { botImageUrlForOrg, getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";
import {
	buildLiveRecordingConfig,
	withRecordingRetention,
} from "./realtime-config";

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_RECORD_SYNC_WINDOW_MS = 28 * DAY_MS;
const UPCOMING_EVENTS_WINDOW_MS = 14 * DAY_MS;

const TERMINAL_MEETING_BOT_STATUSES: readonly MeetingBotStatus[] = [
	"fatal",
	"failed",
	"cancelled",
	"opted_out",
	"complete",
];

const isNonTerminalStatus = (status: MeetingBotStatus) =>
	!TERMINAL_MEETING_BOT_STATUSES.includes(status);

export type MeetingCalendarRow = typeof meetingCalendars.$inferSelect;

export type CalendarEventAction = "schedule" | "cancel" | "none";

export function calendarEventSeriesKey(
	event: Pick<RecallCalendarEvent, "ical_uid" | "raw">,
): string | null {
	const raw = event.raw;
	if (raw && typeof raw === "object" && "recurringEventId" in raw) {
		const recurringEventId = (raw as { recurringEventId?: unknown })
			.recurringEventId;
		if (typeof recurringEventId === "string" && recurringEventId.trim()) {
			return recurringEventId.trim();
		}
	}
	const uid = event.ical_uid?.trim();
	if (!uid) return null;
	const match = uid.match(/^(.+?)(?:_R|@)/);
	return match?.[1] ?? null;
}

export function decideCalendarEventAction(
	event: Pick<RecallCalendarEvent, "is_deleted" | "meeting_url" | "end_time">,
	calendar: { autoRecord: boolean },
	existingRow: { status: MeetingBotStatus } | null,
	now: Date,
	seriesRule: { record: boolean } | null = null,
): CalendarEventAction {
	if (event.is_deleted) {
		return existingRow && isNonTerminalStatus(existingRow.status)
			? "cancel"
			: "none";
	}
	if (!event.meeting_url) return "none";
	if (new Date(event.end_time) < now) return "none";
	if (existingRow?.status === "opted_out") return "none";
	if (existingRow && isNonTerminalStatus(existingRow.status)) return "schedule";
	if (seriesRule) return seriesRule.record ? "schedule" : "none";
	if (calendar.autoRecord) return "schedule";
	return "none";
}

function extractEventTitle(event: RecallCalendarEvent): string | null {
	const raw = event.raw;
	if (raw && typeof raw === "object" && "summary" in raw) {
		const summary = (raw as { summary?: unknown }).summary;
		return typeof summary === "string" ? summary : null;
	}
	return null;
}

type CalendarRef = {
	id: string;
	orgId: Organisation.OrganisationId;
	userId: User.UserId;
};

async function findMeetingBotRowByEventId(eventId: string) {
	const [row] = await db()
		.select({ id: meetingBots.id, status: meetingBots.status })
		.from(meetingBots)
		.where(eq(meetingBots.calendarEventId, eventId))
		.limit(1);
	return row ?? null;
}

async function upsertSchedulingRow({
	calendar,
	event,
	title,
}: {
	calendar: CalendarRef;
	event: RecallCalendarEvent;
	title: string | null;
}): Promise<string> {
	const existing = await findMeetingBotRowByEventId(event.id);
	const joinAt = new Date(event.start_time);
	const endAt = new Date(event.end_time);
	const meetingUrl = event.meeting_url ?? "";

	if (existing) {
		await db()
			.update(meetingBots)
			.set({
				title,
				meetingUrl,
				joinAt,
				endAt,
				status: "scheduling",
				errorMessage: null,
			})
			.where(eq(meetingBots.id, existing.id));
		return existing.id;
	}

	const id = nanoId();
	await db().insert(meetingBots).values({
		id,
		orgId: calendar.orgId,
		ownerId: calendar.userId,
		source: "calendar",
		meetingUrl,
		title,
		joinAt,
		endAt,
		calendarId: calendar.id,
		calendarEventId: event.id,
		status: "scheduling",
	});
	return id;
}

export async function scheduleCalendarEventBotForRow({
	calendar,
	event,
	client = getDefaultRecallClient(),
	botImage,
}: {
	calendar: CalendarRef;
	event: RecallCalendarEvent;
	client?: RecallClient;
	botImage?: RecallAutomaticVideoOutput | null;
}): Promise<void> {
	const config = getRecallConfig();
	if (!config) throw new Error("Recall is not configured");

	const rowId = await upsertSchedulingRow({
		calendar,
		event,
		title: extractEventTitle(event),
	});

	const automaticVideoOutput =
		botImage !== undefined
			? botImage
			: await loadBotVideoOutput({
					botImageUrl: botImageUrlForOrg(config, calendar.orgId),
				});
	const recordingConfig = withRecordingRetention(
		config,
		buildLiveRecordingConfig(config),
	);

	try {
		const updated = await client.scheduleCalendarEventBot(event.id, {
			deduplicationKey: `${event.start_time}-${event.meeting_url}`,
			botConfig: {
				bot_name: config.botName,
				automatic_leave: BOT_AUTOMATIC_LEAVE,
				chat: {
					on_bot_join: {
						send_to: "everyone",
						message: buildJoinChatMessage(config),
						pin: true,
					},
				},
				metadata: { cap_meeting_bot_id: rowId, cap_org_id: calendar.orgId },
				...(automaticVideoOutput
					? { automatic_video_output: automaticVideoOutput }
					: {}),
				...(recordingConfig ? { recording_config: recordingConfig } : {}),
			},
		});
		const recallBotId = updated.bots.at(-1)?.bot_id ?? null;
		await db()
			.update(meetingBots)
			.set({ status: "scheduled", recallBotId })
			.where(eq(meetingBots.id, rowId));
	} catch (error) {
		await db()
			.update(meetingBots)
			.set({
				status: "failed",
				errorMessage:
					error instanceof RecallApiError
						? `Recall rejected the request (HTTP ${error.status})`
						: "Failed to schedule the meeting bot",
			})
			.where(eq(meetingBots.id, rowId));
		throw error;
	}
}

async function loadSeriesRules(
	calendarId: string,
): Promise<Map<string, { record: boolean }>> {
	const rules = await db()
		.select({
			seriesKey: meetingCalendarSeriesRules.seriesKey,
			record: meetingCalendarSeriesRules.record,
		})
		.from(meetingCalendarSeriesRules)
		.where(eq(meetingCalendarSeriesRules.calendarId, calendarId));
	return new Map(
		rules.map((rule) => [rule.seriesKey, { record: rule.record }]),
	);
}

export async function applyCalendarEventDecisions({
	calendar,
	events,
	now,
}: {
	calendar: CalendarRef & { autoRecord: boolean };
	events: RecallCalendarEvent[];
	now: Date;
}): Promise<void> {
	const seriesRules = await loadSeriesRules(calendar.id);
	const sorted = [...events].sort((a, b) =>
		a.start_time.localeCompare(b.start_time),
	);

	for (const event of sorted) {
		const existingRow = await findMeetingBotRowByEventId(event.id);
		const seriesKey = calendarEventSeriesKey(event);
		const seriesRule = seriesKey ? (seriesRules.get(seriesKey) ?? null) : null;
		const action = decideCalendarEventAction(
			event,
			calendar,
			existingRow,
			now,
			seriesRule,
		);
		try {
			if (action === "schedule") {
				await scheduleCalendarEventBotForRow({ calendar, event });
			} else if (action === "cancel" && existingRow) {
				await db()
					.update(meetingBots)
					.set({ status: "cancelled" })
					.where(eq(meetingBots.id, existingRow.id));
			}
		} catch (error) {
			console.error("[recall] calendar event sync failed", {
				calendarId: calendar.id,
				eventId: event.id,
				error: error instanceof Error ? error.message : "unknown",
			});
		}
	}
}

async function requireOwnedCalendar(
	calendarRowId: string,
	userId: User.UserId,
): Promise<MeetingCalendarRow> {
	const [row] = await db()
		.select()
		.from(meetingCalendars)
		.where(eq(meetingCalendars.id, calendarRowId))
		.limit(1);
	if (!row || row.userId !== userId) throw new Error("Calendar not found");
	return row;
}

async function cancelNonTerminalRowsForCalendar(
	calendarRowId: string,
): Promise<void> {
	await db()
		.update(meetingBots)
		.set({ status: "cancelled" })
		.where(
			and(
				eq(meetingBots.calendarId, calendarRowId),
				notInArray(meetingBots.status, [...TERMINAL_MEETING_BOT_STATUSES]),
			),
		);
}

function normalizeCalendarStatus(
	status: string,
): "connecting" | "connected" | "disconnected" {
	if (status === "connected") return "connected";
	if (status === "disconnected") return "disconnected";
	return "connecting";
}

export async function syncCalendarStatus(
	recallCalendarId: string,
	client: RecallClient = getDefaultRecallClient(),
): Promise<void> {
	const remote = await client.getCalendar(recallCalendarId);
	const status = normalizeCalendarStatus(remote.status);

	await db()
		.update(meetingCalendars)
		.set({ status, platformEmail: remote.platform_email })
		.where(eq(meetingCalendars.recallCalendarId, recallCalendarId));

	if (status !== "disconnected") return;

	const [row] = await db()
		.select({ id: meetingCalendars.id })
		.from(meetingCalendars)
		.where(eq(meetingCalendars.recallCalendarId, recallCalendarId))
		.limit(1);
	if (row) await cancelNonTerminalRowsForCalendar(row.id);
}

export async function disconnectCalendar({
	calendarRowId,
	userId,
	client = getDefaultRecallClient(),
}: {
	calendarRowId: string;
	userId: User.UserId;
	client?: RecallClient;
}): Promise<void> {
	const calendar = await requireOwnedCalendar(calendarRowId, userId);
	await client.deleteCalendar(calendar.recallCalendarId);
	await cancelNonTerminalRowsForCalendar(calendar.id);
	await db()
		.delete(meetingCalendars)
		.where(eq(meetingCalendars.id, calendar.id));
}

export async function setCalendarAutoRecord({
	calendarRowId,
	userId,
	autoRecord,
	client = getDefaultRecallClient(),
	now = () => new Date(),
}: {
	calendarRowId: string;
	userId: User.UserId;
	autoRecord: boolean;
	client?: RecallClient;
	now?: () => Date;
}): Promise<void> {
	const calendar = await requireOwnedCalendar(calendarRowId, userId);
	await db()
		.update(meetingCalendars)
		.set({ autoRecord })
		.where(eq(meetingCalendars.id, calendar.id));
	if (!autoRecord) return;

	const nowDate = now();
	const events = await client.listCalendarEvents({
		calendarId: calendar.recallCalendarId,
		startTimeGte: nowDate.toISOString(),
		startTimeLte: new Date(
			nowDate.getTime() + AUTO_RECORD_SYNC_WINDOW_MS,
		).toISOString(),
		isDeleted: false,
	});
	await applyCalendarEventDecisions({
		calendar: {
			id: calendar.id,
			orgId: calendar.orgId,
			userId: calendar.userId,
			autoRecord,
		},
		events,
		now: nowDate,
	});
	await db()
		.update(meetingCalendars)
		.set({ lastSyncedAt: nowDate })
		.where(eq(meetingCalendars.id, calendar.id));
}

export async function toggleCalendarEventRecording({
	calendarRowId,
	userId,
	eventId,
	record,
	client = getDefaultRecallClient(),
}: {
	calendarRowId: string;
	userId: User.UserId;
	eventId: string;
	record: boolean;
	client?: RecallClient;
}): Promise<void> {
	const calendarRow = await requireOwnedCalendar(calendarRowId, userId);
	const calendar: CalendarRef = {
		id: calendarRow.id,
		orgId: calendarRow.orgId,
		userId: calendarRow.userId,
	};

	if (record) {
		const event = await client.getCalendarEvent(eventId);
		await scheduleCalendarEventBotForRow({ calendar, event, client });
		return;
	}

	await client.removeCalendarEventBot(eventId);
	const existing = await findMeetingBotRowByEventId(eventId);
	if (existing) {
		await db()
			.update(meetingBots)
			.set({ status: "opted_out" })
			.where(eq(meetingBots.id, existing.id));
		return;
	}

	const event = await client.getCalendarEvent(eventId);
	await db()
		.insert(meetingBots)
		.values({
			id: nanoId(),
			orgId: calendar.orgId,
			ownerId: calendar.userId,
			source: "calendar",
			meetingUrl: event.meeting_url ?? "",
			title: extractEventTitle(event),
			joinAt: new Date(event.start_time),
			endAt: new Date(event.end_time),
			calendarId: calendar.id,
			calendarEventId: eventId,
			status: "opted_out",
		});
}

export type UpcomingCalendarEvent = {
	id: string;
	title: string | null;
	startTime: string;
	endTime: string;
	meetingUrl: string | null;
	platform: string | null;
	recording: boolean;
	status: MeetingBotStatus | null;
	seriesKey: string | null;
	seriesRule: boolean | null;
};

export async function listUpcomingCalendarEvents({
	calendarRowId,
	client = getDefaultRecallClient(),
	now = () => new Date(),
}: {
	calendarRowId: string;
	client?: RecallClient;
	now?: () => Date;
}): Promise<UpcomingCalendarEvent[]> {
	const [calendar] = await db()
		.select()
		.from(meetingCalendars)
		.where(eq(meetingCalendars.id, calendarRowId))
		.limit(1);
	if (!calendar) return [];

	const nowDate = now();
	const events = await client.listCalendarEvents({
		calendarId: calendar.recallCalendarId,
		startTimeGte: nowDate.toISOString(),
		startTimeLte: new Date(
			nowDate.getTime() + UPCOMING_EVENTS_WINDOW_MS,
		).toISOString(),
		isDeleted: false,
	});

	const rows = await db()
		.select({
			calendarEventId: meetingBots.calendarEventId,
			status: meetingBots.status,
		})
		.from(meetingBots)
		.where(eq(meetingBots.calendarId, calendarRowId));
	const statusByEventId = new Map(
		rows
			.filter((row) => row.calendarEventId !== null)
			.map((row) => [row.calendarEventId as string, row.status]),
	);
	const seriesRules = await loadSeriesRules(calendarRowId);

	return events
		.filter((event) => event.meeting_url)
		.map((event) => {
			const status = statusByEventId.get(event.id) ?? null;
			const seriesKey = calendarEventSeriesKey(event);
			return {
				id: event.id,
				title: extractEventTitle(event),
				startTime: event.start_time,
				endTime: event.end_time,
				meetingUrl: event.meeting_url,
				platform: event.meeting_platform,
				recording: status !== null && status !== "opted_out",
				status,
				seriesKey,
				seriesRule: seriesKey
					? (seriesRules.get(seriesKey)?.record ?? null)
					: null,
			};
		});
}

export async function setCalendarSeriesRule({
	calendarRowId,
	userId,
	eventId,
	record,
	client = getDefaultRecallClient(),
	now = () => new Date(),
}: {
	calendarRowId: string;
	userId: User.UserId;
	eventId: string;
	record: boolean;
	client?: RecallClient;
	now?: () => Date;
}): Promise<void> {
	const calendar = await requireOwnedCalendar(calendarRowId, userId);
	const event = await client.getCalendarEvent(eventId);
	const seriesKey = calendarEventSeriesKey(event);
	if (!seriesKey) throw new Error("Event is not part of a recurring series");

	const title = extractEventTitle(event);
	const [existing] = await db()
		.select({ id: meetingCalendarSeriesRules.id })
		.from(meetingCalendarSeriesRules)
		.where(
			and(
				eq(meetingCalendarSeriesRules.calendarId, calendar.id),
				eq(meetingCalendarSeriesRules.seriesKey, seriesKey),
			),
		)
		.limit(1);

	if (existing) {
		await db()
			.update(meetingCalendarSeriesRules)
			.set({ record, title })
			.where(eq(meetingCalendarSeriesRules.id, existing.id));
	} else {
		await db().insert(meetingCalendarSeriesRules).values({
			id: nanoId(),
			calendarId: calendar.id,
			seriesKey,
			record,
			title,
		});
	}

	const nowDate = now();
	const upcoming = await client.listCalendarEvents({
		calendarId: calendar.recallCalendarId,
		startTimeGte: nowDate.toISOString(),
		startTimeLte: new Date(
			nowDate.getTime() + AUTO_RECORD_SYNC_WINDOW_MS,
		).toISOString(),
		isDeleted: false,
	});
	await applyCalendarEventDecisions({
		calendar: {
			id: calendar.id,
			orgId: calendar.orgId,
			userId: calendar.userId,
			autoRecord: calendar.autoRecord,
		},
		events: upcoming.filter(
			(upcomingEvent) => calendarEventSeriesKey(upcomingEvent) === seriesKey,
		),
		now: nowDate,
	});
}

export async function getUserCalendar({
	orgId,
	userId,
}: {
	orgId: Organisation.OrganisationId;
	userId: User.UserId;
}): Promise<MeetingCalendarRow | null> {
	const [row] = await db()
		.select()
		.from(meetingCalendars)
		.where(
			and(
				eq(meetingCalendars.orgId, orgId),
				eq(meetingCalendars.userId, userId),
			),
		)
		.orderBy(desc(meetingCalendars.createdAt))
		.limit(1);
	return row ?? null;
}
