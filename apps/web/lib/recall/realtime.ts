import { db } from "@cap/database";
import { meetingBots } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { loadOrganizationSummaryLanguage } from "@/lib/summary-language";
import { type ChatAgentDeps, handleLiveChatMessage } from "./chat-agent";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./config";
import { appendChat, appendUtterance } from "./live-transcript";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: null;
}

function string(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type RealtimePayload = { event: string; data: unknown };

type RealtimeDeps = {
	appendUtterance?: typeof appendUtterance;
	appendChat?: typeof appendChat;
	handleChatMessage?: typeof handleLiveChatMessage;
	chatAgent?: ChatAgentDeps;
	deferChat?: (work: () => Promise<unknown>) => void;
};

export async function handleRealtimeEvent(
	payload: RealtimePayload,
	deps: RealtimeDeps = {},
): Promise<void> {
	const envelope = record(payload.data);
	const bot = record(envelope?.bot);
	const recallBotId = string(bot?.id);
	if (!recallBotId) return;
	const [meeting] = await db()
		.select({ id: meetingBots.id, orgId: meetingBots.orgId })
		.from(meetingBots)
		.where(eq(meetingBots.recallBotId, recallBotId))
		.limit(1);
	if (!meeting) return;
	const data = record(envelope?.data);
	if (!data) return;
	if (payload.event === "transcript.data") {
		const words = Array.isArray(data.words) ? data.words : [];
		const text = words
			.map((word) => string(record(word)?.text))
			.filter((word): word is string => Boolean(word))
			.join(" ");
		const first = record(words[0]);
		const start = number(record(first?.start_timestamp)?.relative);
		const participant = record(data.participant);
		if (!text || start === null) return;
		await (deps.appendUtterance ?? appendUtterance)(meeting.id, {
			t: start,
			speaker: string(participant?.name) ?? "Participant",
			text,
		});
		return;
	}
	if (payload.event === "participant_events.chat_message") {
		const message = record(data.data);
		const participant = record(data.participant);
		const timestamp = number(record(data.timestamp)?.relative);
		const text = string(message?.text);
		if (!text || timestamp === null) return;
		const speaker = string(participant?.name) ?? "Participant";
		const botName =
			deps.chatAgent?.botName ?? getRecallConfig()?.botName ?? DEFAULT_BOT_NAME;
		if (speaker.trim().toLowerCase() === botName.trim().toLowerCase()) return;
		const work = async () => {
			await (deps.appendChat ?? appendChat)(meeting.id, {
				t: timestamp,
				speaker,
				text,
				fromBot: false,
			});
			const summaryLanguage =
				deps.chatAgent?.summaryLanguage ??
				(meeting.orgId
					? await loadOrganizationSummaryLanguage(meeting.orgId)
					: undefined);
			await (deps.handleChatMessage ?? handleLiveChatMessage)(
				{
					meetingBotId: meeting.id,
					recallBotId,
					text,
					speaker,
					timestamp,
				},
				{ ...deps.chatAgent, summaryLanguage },
			);
		};
		if (deps.deferChat) deps.deferChat(work);
		else await work();
	}
}
