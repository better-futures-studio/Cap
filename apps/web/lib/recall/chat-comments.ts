import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { comments, meetingBots } from "@cap/database/schema";
import { Comment } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { buildJoinChatMessage } from "./bot-chat";
import { isCapturePrompt, messageWithoutInvocation } from "./chat-agent";
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

function isAgentCommand(text: string, trigger: string): boolean {
	const normalizedTrigger = trigger.trim().toLowerCase();
	if (!normalizedTrigger) return false;
	return text.trim().toLowerCase().startsWith(normalizedTrigger);
}

function stripTrigger(text: string, trigger: string): string {
	const normalizedTrigger = trigger.trim();
	if (!normalizedTrigger) return text.trim();
	const trimmed = text.trim();
	if (!trimmed.toLowerCase().startsWith(normalizedTrigger.toLowerCase())) {
		return trimmed;
	}
	return trimmed.slice(normalizedTrigger.length).trim();
}

function joinMessagePrefix(botName: string): string {
	return buildJoinChatMessage({
		botName,
		liveAgent: false,
		agentTrigger: "",
	});
}

function isJoinMessage(text: string, botName: string): boolean {
	const prefix = joinMessagePrefix(botName);
	const trimmed = text.trim();
	const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
	return firstLine === prefix || trimmed.startsWith(prefix);
}

function isCaptureCommand(
	text: string,
	trigger: string,
	botName: string,
): boolean {
	if (!isAgentCommand(text, trigger)) return false;
	return isCapturePrompt(messageWithoutInvocation(text, trigger, botName));
}

function formatChatContent(
	event: RecallParticipantEvent & { data: { text: string; to: string } },
	botName: string,
	trigger: string,
): string {
	const text = event.data.text.trim();
	const name = event.participant.name?.trim() || "Participant";
	if (name === botName) {
		return `${botName}: ${text}`.slice(0, MAX_COMMENT_CONTENT);
	}
	if (isAgentCommand(text, trigger)) {
		return `${name} (to ${botName}): ${stripTrigger(text, trigger)}`.slice(
			0,
			MAX_COMMENT_CONTENT,
		);
	}
	return `${name}: ${text}`.slice(0, MAX_COMMENT_CONTENT);
}

function isChatEvent(
	event: RecallParticipantEvent,
	botName: string,
	trigger: string,
): event is RecallParticipantEvent & { data: { text: string; to: string } } {
	if (event.action !== "chat_message") return false;
	const text = event.data?.text?.trim();
	if (!text) return false;
	const relative = event.timestamp?.relative;
	if (!Number.isFinite(relative) || relative < 0) return false;
	if (event.participant?.name === botName) return !isJoinMessage(text, botName);
	return !isCaptureCommand(text, trigger, botName);
}

export async function importMeetingChatComments(
	{ meetingBotId }: { meetingBotId: string },
	deps: { client?: RecallClient; botName?: string; agentTrigger?: string } = {},
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
		const config = getRecallConfig();
		const botName = deps.botName ?? config?.botName ?? DEFAULT_BOT_NAME;
		const agentTrigger = deps.agentTrigger ?? config?.agentTrigger ?? "/nt";
		const chatEvents = (Array.isArray(events) ? events : []).filter((event) =>
			isChatEvent(event, botName, agentTrigger),
		);

		if (chatEvents.length === 0) {
			return { imported: 0, skipped: false };
		}

		await db()
			.insert(comments)
			.values(
				chatEvents.map((event) => {
					const content = formatChatContent(event, botName, agentTrigger);
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
