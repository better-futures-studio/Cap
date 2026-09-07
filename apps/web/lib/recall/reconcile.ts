import { db } from "@cap/database";
import { meetingBots } from "@cap/database/schema";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { start } from "workflow/api";
import { importRecallRecordingWorkflow } from "@/workflows/recall-meeting";
import { reconcileStaleSchedulingRows } from "./bots";
import { importMeetingChatComments } from "./chat-comments";
import { RecallApiError, type RecallClient } from "./client";
import {
	DEFAULT_BOT_NAME,
	getRecallConfig,
	isRecallConfigured,
} from "./config";
import { getDefaultRecallClient } from "./default-client";
import { sendMeetingRecap } from "./recap";
import {
	attendeesFromCalendarEvent,
	migrateMeetingSpacesToVideoShares,
} from "./visibility";

const MISSED_RECORDING_MS = 15 * 60 * 1000;

async function reconcileMissedDoneRows(): Promise<number> {
	const client = getDefaultRecallClient();
	const cutoff = new Date(Date.now() - MISSED_RECORDING_MS);
	const rows = await db()
		.select()
		.from(meetingBots)
		.where(
			and(
				inArray(meetingBots.status, ["done", "call_ended", "transcribing"]),
				isNull(meetingBots.recallRecordingId),
				isNull(meetingBots.videoId),
				lt(meetingBots.updatedAt, cutoff),
			),
		);

	let started = 0;
	for (const row of rows) {
		if (!row.recallBotId) continue;
		try {
			const bot = await client.getBot(row.recallBotId);
			const recordingId = bot.recordings[0]?.id;
			if (!recordingId) continue;
			await start(importRecallRecordingWorkflow, [
				{ meetingBotId: row.id, recordingId },
			]);
			started += 1;
			console.info("[recall] started missed recording import", {
				meetingBotId: row.id,
				recallBotId: row.recallBotId,
				recordingId,
			});
		} catch (error) {
			console.error("[recall] reconcile missed recording failed", {
				meetingBotId: row.id,
				recallBotId: row.recallBotId,
				status: error instanceof RecallApiError ? error.status : undefined,
			});
		}
	}
	return started;
}

async function backfillChatComments(): Promise<number> {
	const rows = await db()
		.select({ id: meetingBots.id })
		.from(meetingBots)
		.where(
			and(
				isNotNull(meetingBots.videoId),
				isNotNull(meetingBots.recallRecordingId),
				isNull(meetingBots.chatSyncedAt),
				inArray(meetingBots.status, ["transcribing", "complete"]),
			),
		)
		.orderBy(asc(meetingBots.createdAt))
		.limit(20);

	let chatBackfill = 0;
	for (const row of rows) {
		try {
			await importMeetingChatComments({ meetingBotId: row.id });
			chatBackfill += 1;
		} catch (error) {
			console.error("[recall] chat backfill failed", {
				meetingBotId: row.id,
				status: error instanceof RecallApiError ? error.status : undefined,
			});
		}
	}
	return chatBackfill;
}

async function sendPendingRecapEmails(): Promise<number> {
	const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	const rows = await db()
		.select({ id: meetingBots.id })
		.from(meetingBots)
		.where(
			and(
				eq(meetingBots.status, "complete"),
				isNull(meetingBots.recapSentAt),
				isNotNull(meetingBots.videoId),
				gte(meetingBots.createdAt, cutoff),
			),
		)
		.orderBy(asc(meetingBots.createdAt))
		.limit(20);

	let recapEmails = 0;
	for (const row of rows) {
		try {
			await sendMeetingRecap(row.id);
			recapEmails += 1;
		} catch (error) {
			console.error("[recall] recap email failed", {
				meetingBotId: row.id,
				error: error instanceof Error ? error.message : "unknown",
			});
		}
	}
	return recapEmails;
}

const ATTENDEE_BACKFILL_LIMIT = 50;
const ATTENDEE_BACKFILL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export async function backfillCalendarAttendeeEmails(
	client: RecallClient = getDefaultRecallClient(),
	now = new Date(),
): Promise<number> {
	const cutoff = new Date(now.getTime() - ATTENDEE_BACKFILL_LOOKBACK_MS);
	const rows = await db()
		.select({
			id: meetingBots.id,
			calendarEventId: meetingBots.calendarEventId,
		})
		.from(meetingBots)
		.where(
			and(
				eq(meetingBots.source, "calendar"),
				isNull(meetingBots.attendeeEmails),
				isNotNull(meetingBots.calendarEventId),
				gte(meetingBots.joinAt, cutoff),
			),
		)
		.orderBy(asc(meetingBots.joinAt))
		.limit(ATTENDEE_BACKFILL_LIMIT);

	const botName = getRecallConfig()?.botName ?? DEFAULT_BOT_NAME;
	let filled = 0;
	for (const row of rows) {
		if (!row.calendarEventId) continue;
		try {
			const event = await client.getCalendarEvent(row.calendarEventId);
			const attendees = attendeesFromCalendarEvent(event, botName);
			await db()
				.update(meetingBots)
				.set(attendees)
				.where(eq(meetingBots.id, row.id));
			filled += 1;
		} catch (error) {
			console.error("[recall] attendee backfill failed", {
				meetingBotId: row.id,
				status: error instanceof RecallApiError ? error.status : undefined,
			});
		}
	}
	return filled;
}

export async function reconcileRecallMeetingBots(): Promise<{
	staleScheduling: number;
	missedRecordings: number;
	chatBackfill: number;
	recapEmails: number;
	attendeeBackfill: number;
	spacesMigrated: number;
	videosPrivatized: number;
} | null> {
	if (!isRecallConfigured()) return null;
	const [
		staleScheduling,
		missedRecordings,
		chatBackfill,
		recapEmails,
		attendeeBackfill,
		shareMigration,
	] = await Promise.all([
		reconcileStaleSchedulingRows(getDefaultRecallClient()),
		reconcileMissedDoneRows(),
		backfillChatComments(),
		sendPendingRecapEmails(),
		backfillCalendarAttendeeEmails(),
		migrateMeetingSpacesToVideoShares(),
	]);
	return {
		staleScheduling,
		missedRecordings,
		chatBackfill,
		recapEmails,
		attendeeBackfill,
		spacesMigrated: shareMigration.spacesMigrated,
		videosPrivatized: shareMigration.videosPrivatized,
	};
}
