import { db } from "@cap/database";
import { meetingBots } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import type { RecallClient } from "./client";
import { getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";

function isSharedSubCode(value: string | null | undefined): boolean {
	return !!value?.startsWith("shared:");
}

export async function maybeDeleteRecallMediaIfUnused(
	recallBotId: string,
	deps: { client?: RecallClient } = {},
): Promise<void> {
	const config = getRecallConfig();
	if (!config?.deleteMediaAfterImport) return;

	const siblings = await db()
		.select({
			videoId: meetingBots.videoId,
			statusSubCode: meetingBots.statusSubCode,
		})
		.from(meetingBots)
		.where(eq(meetingBots.recallBotId, recallBotId))
		.limit(50);

	const stillNeeded = siblings.some(
		(row) => !row.videoId && !isSharedSubCode(row.statusSubCode),
	);
	if (stillNeeded) return;

	const client = deps.client ?? getDefaultRecallClient();
	try {
		await client.deleteBotMedia(recallBotId);
	} catch (error) {
		console.error("[recall] delete_media failed", {
			recallBotId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

export async function maybeDeleteImportedRecallMedia(
	meetingBotId: string,
	deps: { client?: RecallClient } = {},
): Promise<void> {
	if (!getRecallConfig()?.deleteMediaAfterImport) return;
	const [row] = await db()
		.select({ recallBotId: meetingBots.recallBotId })
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);
	if (!row?.recallBotId) return;
	await maybeDeleteRecallMediaIfUnused(row.recallBotId, deps);
}
