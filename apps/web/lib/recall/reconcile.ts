import { db } from "@cap/database";
import { meetingBots } from "@cap/database/schema";
import { and, eq, isNull, lt } from "drizzle-orm";
import { start } from "workflow/api";
import { importRecallRecordingWorkflow } from "@/workflows/recall-meeting";
import { reconcileStaleSchedulingRows } from "./bots";
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

export async function reconcileRecallMeetingBots(): Promise<{
	staleScheduling: number;
	missedRecordings: number;
} | null> {
	if (!isRecallConfigured()) return null;
	const [staleScheduling, missedRecordings] = await Promise.all([
		reconcileStaleSchedulingRows(getDefaultRecallClient()),
		reconcileMissedDoneRows(),
	]);
	return { staleScheduling, missedRecordings };
}
