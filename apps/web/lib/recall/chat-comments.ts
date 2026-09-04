import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { comments, meetingBots } from "@cap/database/schema";
import { Comment } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import {
	RecallApiError,
	type RecallClient,
	type RecallParticipantEvent,
} from "./client";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";

const MAX_COMMENT_CONTENT = 2000;

function getAffectedRows(result: unknown): number {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

function isChatEvent(
	event: RecallParticipantEvent,
	botName: string,
): event is RecallParticipantEvent & { data: { text: string; to: string } } {
	if (event.action !== "chat_message") return false;
	const text = event.data?.text?.trim();
	if (!text) return false;
	const relative = event.timestamp?.relative;
	if (!Number.isFinite(relative) || relative < 0) return false;
	return event.participant?.name !== botName;
}

export async function importMeetingChatComments(
	{ meetingBotId }: { meetingBotId: string },
	deps: { client?: RecallClient; botName?: string } = {},
): Promise<{ imported: number; skipped: boolean }> {
	const [row] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);

	if (!row?.videoId || !row.recallRecordingId) {
		return { imported: 0, skipped: true };
	}

	const videoId = row.videoId;
	const recallRecordingId = row.recallRecordingId;

	const claimed = await db()
		.update(meetingBots)
		.set({ chatSyncedAt: new Date() })
		.where(
			and(eq(meetingBots.id, meetingBotId), isNull(meetingBots.chatSyncedAt)),
		);
	if (getAffectedRows(claimed) === 0) {
		return { imported: 0, skipped: true };
	}

	try {
		const client = deps.client ?? getDefaultRecallClient();
		const recording = await client.getRecording(recallRecordingId);
		const downloadUrl =
			recording.media_shortcuts.participant_events?.data
				?.participant_events_download_url;
		if (!downloadUrl) {
			return { imported: 0, skipped: false };
		}

		const events =
			await client.downloadJson<RecallParticipantEvent[]>(downloadUrl);
		const botName =
			deps.botName ?? getRecallConfig()?.botName ?? DEFAULT_BOT_NAME;
		const chatEvents = (Array.isArray(events) ? events : []).filter((event) =>
			isChatEvent(event, botName),
		);

		if (chatEvents.length === 0) {
			return { imported: 0, skipped: false };
		}

		await db()
			.insert(comments)
			.values(
				chatEvents.map((event) => {
					const text = event.data.text.trim();
					const content =
						`${event.participant.name?.trim() || "Participant"}: ${text}`.slice(
							0,
							MAX_COMMENT_CONTENT,
						);
					return {
						id: Comment.CommentId.make(nanoId()),
						type: "text" as const,
						content,
						timestamp: Math.round(event.timestamp.relative * 1000) / 1000,
						authorId: row.ownerId,
						videoId,
					};
				}),
			);

		return { imported: chatEvents.length, skipped: false };
	} catch (error) {
		await db()
			.update(meetingBots)
			.set({ chatSyncedAt: null })
			.where(eq(meetingBots.id, meetingBotId));
		console.error("[recall] chat import failed", {
			meetingBotId,
			status: error instanceof RecallApiError ? error.status : undefined,
		});
		throw error;
	}
}
