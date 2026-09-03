import { db } from "@cap/database";
import { meetingBots } from "@cap/database/schema";
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { start } from "workflow/api";
import { importRecallRecordingWorkflow } from "@/workflows/recall-meeting";
import { reconcileStaleSchedulingRows } from "./bots";
import { importMeetingChatComments } from "./chat-comments";
import { RecallApiError } from "./client";
import { isRecallConfigured } from "./config";
import { getDefaultRecallClient } from "./default-client";

const MISSED_RECORDING_MS = 15 * 60 * 1000;

async function reconcileMissedDoneRows(): Promise<number> {
	const client = getDefaultRecallClient();
	const cutoff = new Date(Date.now() - MISSED_RECORDING_MS);
	const rows = await db()
		.select()
		.from(meetingBots)
		.where(
			and(
				eq(meetingBots.status, "done"),
				isNull(meetingBots.recallRecordingId),
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

export async function reconcileRecallMeetingBots(): Promise<{
	staleScheduling: number;
	missedRecordings: number;
	chatBackfill: number;
} | null> {
	if (!isRecallConfigured()) return null;
	const [staleScheduling, missedRecordings, chatBackfill] = await Promise.all([
		reconcileStaleSchedulingRows(getDefaultRecallClient()),
		reconcileMissedDoneRows(),
		backfillChatComments(),
	]);
	return { staleScheduling, missedRecordings, chatBackfill };
}
