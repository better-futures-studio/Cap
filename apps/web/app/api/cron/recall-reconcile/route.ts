import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { meetingBots } from "@cap/database/schema";
import { and, eq, isNull, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { reconcileStaleSchedulingRows } from "@/lib/recall/bots";
import { RecallApiError } from "@/lib/recall/client";
import { isRecallConfigured } from "@/lib/recall/config";
import { getDefaultRecallClient } from "@/lib/recall/default-client";
import { importRecallRecordingWorkflow } from "@/workflows/recall-meeting";

export const dynamic = "force-dynamic";

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

export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	const authHeader = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;
	if (
		!authHeader ||
		authHeader.length !== expected.length ||
		!timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	if (!isRecallConfigured()) {
		return NextResponse.json(
			{ error: "Recall is not configured" },
			{ status: 503 },
		);
	}

	const [staleScheduling, missedRecordings] = await Promise.all([
		reconcileStaleSchedulingRows(getDefaultRecallClient()),
		reconcileMissedDoneRows(),
	]);

	return NextResponse.json({
		success: true,
		staleScheduling,
		missedRecordings,
	});
}
