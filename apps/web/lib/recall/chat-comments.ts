import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	comments,
	meetingBots,
	organizationMembers,
	users,
} from "@cap/database/schema";
import { Comment, type User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { getOrCreateSystemUser } from "../system-users";
import { buildJoinChatMessage } from "./bot-chat";
import { isCapturePrompt, messageWithoutInvocation } from "./chat-agent";
import {
	RecallApiError,
	type RecallClient,
	type RecallParticipantEvent,
} from "./client";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";
import { type LiveTranscript, readLiveTranscript } from "./live-transcript";

const MAX_COMMENT_CONTENT = 2000;
const CAPTURE_ACKNOWLEDGEMENT = "Noted.";

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

type OrgMember = {
	id: User.UserId;
	name: string | null;
	email: string;
};

function matchOrgMember(
	participant: { name: string | null; email: string | null },
	members: OrgMember[],
): OrgMember | null {
	const email = participant.email?.trim().toLowerCase();
	if (email) {
		const byEmail = members.find(
			(member) => member.email.trim().toLowerCase() === email,
		);
		if (byEmail) return byEmail;
	}
	const name = participant.name?.trim().toLowerCase();
	if (!name) return null;
	return (
		members.find(
			(member) => (member.name ?? "").trim().toLowerCase() === name,
		) ?? null
	);
}

function formatHumanChatContent({
	text,
	displayName,
	matched,
	botName,
	trigger,
}: {
	text: string;
	displayName: string;
	matched: boolean;
	botName: string;
	trigger: string;
}): string {
	const body = text.trim();
	if (isAgentCommand(body, trigger)) {
		const stripped = stripTrigger(body, trigger);
		if (matched) {
			return `(to ${botName}) ${stripped}`.slice(0, MAX_COMMENT_CONTENT);
		}
		return `${displayName} (to ${botName}): ${stripped}`.slice(
			0,
			MAX_COMMENT_CONTENT,
		);
	}
	if (matched) {
		return body.slice(0, MAX_COMMENT_CONTENT);
	}
	return `${displayName}: ${body}`.slice(0, MAX_COMMENT_CONTENT);
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

function roundedTimestamp(t: number): number {
	return Math.round(t * 1000) / 1000;
}

function normalizeCommentText(text: string): string {
	return text.trim().toLowerCase();
}

function commentDedupeKey(text: string, timestamp: number): string {
	return `${normalizeCommentText(text)}\0${roundedTimestamp(timestamp)}`;
}

function isCaptureAcknowledgement(text: string): boolean {
	return text.trim() === CAPTURE_ACKNOWLEDGEMENT;
}

export async function importMeetingChatComments(
	{ meetingBotId }: { meetingBotId: string },
	deps: {
		client?: RecallClient;
		botName?: string;
		agentTrigger?: string;
		readTranscript?: (meetingBotId: string) => Promise<LiveTranscript | null>;
	} = {},
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
		const events = downloadUrl
			? await client.downloadJson<RecallParticipantEvent[]>(downloadUrl)
			: [];
		const config = getRecallConfig();
		const botName = deps.botName ?? config?.botName ?? DEFAULT_BOT_NAME;
		const agentTrigger = deps.agentTrigger ?? config?.agentTrigger ?? "/nt";
		const [notetaker, external, orgMembers] = await Promise.all([
			getOrCreateSystemUser({ orgId: row.orgId, kind: "notetaker" }),
			getOrCreateSystemUser({ orgId: row.orgId, kind: "external" }),
			db()
				.select({
					id: users.id,
					name: users.name,
					email: users.email,
				})
				.from(users)
				.innerJoin(
					organizationMembers,
					eq(organizationMembers.userId, users.id),
				)
				.where(
					and(
						eq(organizationMembers.organizationId, row.orgId),
						isNull(users.systemKind),
					),
				)
				.limit(500),
		]);
		const chatEvents = (Array.isArray(events) ? events : []).filter((event) =>
			isChatEvent(event, botName, agentTrigger),
		);
		const seen = new Set(
			chatEvents.map((event) =>
				commentDedupeKey(event.data.text, event.timestamp.relative),
			),
		);
		const transcript = await (deps.readTranscript ?? readLiveTranscript)(
			meetingBotId,
		);
		const liveBotReplies = (transcript?.chat ?? []).filter((entry) => {
			if (!entry.fromBot) return false;
			const text = entry.text.trim();
			if (!text) return false;
			if (!Number.isFinite(entry.t) || entry.t < 0) return false;
			if (isJoinMessage(text, botName)) return false;
			if (isCaptureAcknowledgement(text)) return false;
			const key = commentDedupeKey(text, entry.t);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

		const ordered = [
			...chatEvents.map((event) => {
				const text = event.data.text.trim();
				if (event.participant.name === botName) {
					return {
						content: text.slice(0, MAX_COMMENT_CONTENT),
						timestamp: roundedTimestamp(event.timestamp.relative),
						fromBot: false,
						authorId: notetaker.id,
					};
				}
				const member = matchOrgMember(event.participant, orgMembers);
				const displayName = event.participant.name?.trim() || "Participant";
				return {
					content: formatHumanChatContent({
						text,
						displayName,
						matched: member !== null,
						botName,
						trigger: agentTrigger,
					}),
					timestamp: roundedTimestamp(event.timestamp.relative),
					fromBot: false,
					authorId: member?.id ?? external.id,
				};
			}),
			...liveBotReplies.map((entry) => ({
				content: entry.text.trim().slice(0, MAX_COMMENT_CONTENT),
				timestamp: roundedTimestamp(entry.t),
				fromBot: true,
				authorId: notetaker.id,
			})),
		].sort(
			(left, right) =>
				left.timestamp - right.timestamp ||
				Number(left.fromBot) - Number(right.fromBot),
		);
		const base = (row.joinAt ?? row.createdAt ?? new Date(0)).getTime();
		const values = ordered.map((entry, index) => ({
			id: Comment.CommentId.make(nanoId()),
			type: "text" as const,
			content: entry.content,
			timestamp: entry.timestamp,
			authorId: entry.authorId,
			videoId,
			createdAt: new Date(
				base + Math.floor(entry.timestamp) * 1000 + index * 1000,
			),
		}));

		if (values.length === 0) {
			return { imported: 0, skipped: false };
		}

		await db().insert(comments).values(values);

		return { imported: values.length, skipped: false };
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
