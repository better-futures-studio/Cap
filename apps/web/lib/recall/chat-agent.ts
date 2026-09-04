import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { runWithAiProviders } from "@/lib/ai/run";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";
import {
	appendCapture,
	appendChat,
	type LiveChatEntry,
	type LiveTranscript,
	liveContextAsText,
	readLiveTranscript,
} from "./live-transcript";

const MAX_REPLY_CHARS = 600;
const CONTEXT_CHARS = 12_000;
const MAX_CHAT_EXCHANGES = 10;

function liveMeetingSystem(botName: string) {
	return `You are ${botName}, a helpful assistant inside a live meeting. Use the transcript below as context when the question is about the meeting. For anything else, answer directly; use web search when the answer depends on current or external information (weather, news, prices, facts you are not sure of). Keep replies under 600 characters, plain text, no markdown, no links unless asked.`;
}

export type ChatAnswerOptions = {
	webSearch: boolean;
};

export type ChatModelMessage = {
	role: "user" | "assistant";
	content: string;
};

export type ChatAgentDeps = {
	readTranscript?: (meetingBotId: string) => Promise<LiveTranscript | null>;
	appendCapture?: (
		meetingBotId: string,
		capture: { t: number; speaker: string; text: string },
	) => Promise<void>;
	appendChat?: (meetingBotId: string, entry: LiveChatEntry) => Promise<void>;
	answer?: (
		system: string,
		messages: ChatModelMessage[],
		options: ChatAnswerOptions,
	) => Promise<string>;
	send?: (botId: string, params: { message: string }) => Promise<void>;
	botName?: string;
	trigger?: string;
};

const replies = new Set<string>();

function clipped(text: string) {
	return text.trim().slice(0, MAX_REPLY_CHARS);
}

async function llmAnswer(
	system: string,
	messages: ChatModelMessage[],
	options: ChatAnswerOptions,
) {
	return runWithAiProviders("chat", async (selection) => {
		const useWebSearch = options.webSearch && selection.provider === "openai";
		const result = await generateText({
			model: selection.model(),
			system,
			messages,
			maxOutputTokens: selection.defaultMaxOutputTokens,
			...(useWebSearch
				? {
						tools: {
							web_search: openai.tools.webSearch({
								searchContextSize: "low",
							}),
						},
						stopWhen: stepCountIs(3),
					}
				: {}),
		});
		return result.text;
	});
}

export function isAgentMessage(text: string, trigger: string, botName: string) {
	const normalized = text.trim().toLowerCase();
	const normalizedTrigger = trigger.trim().toLowerCase();
	const normalizedBotName = botName.trim().toLowerCase();
	return (
		(Boolean(normalizedTrigger) && normalized.startsWith(normalizedTrigger)) ||
		(Boolean(normalizedBotName) && normalized.includes(normalizedBotName))
	);
}

export function messageWithoutInvocation(
	text: string,
	trigger: string,
	botName: string,
) {
	return text
		.trim()
		.replace(new RegExp(`^${escapeRegExp(trigger)}\\s*`, "i"), "")
		.replace(new RegExp(escapeRegExp(botName), "ig"), "")
		.trim();
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCurrentQuestion(stored: string, question: string) {
	const text = stored.trim();
	const prompt = question.trim();
	return text === prompt || text.endsWith(prompt);
}

function priorChatEntries(
	document: LiveTranscript | null,
	question: string,
): LiveChatEntry[] {
	const chat = document?.chat ?? [];
	const last = chat.at(-1);
	const prior =
		last && !last.fromBot && isCurrentQuestion(last.text, question)
			? chat.slice(0, -1)
			: chat;
	return prior.slice(-MAX_CHAT_EXCHANGES);
}

function meetingMessages(
	document: LiveTranscript | null,
	question: string,
): ChatModelMessage[] {
	const context = liveContextAsText(document, CONTEXT_CHARS);
	const messages: ChatModelMessage[] = [];
	if (context) {
		messages.push({ role: "user", content: `Meeting context\n${context}` });
	}
	for (const entry of priorChatEntries(document, question)) {
		messages.push(
			entry.fromBot
				? { role: "assistant", content: entry.text }
				: { role: "user", content: `${entry.speaker}: ${entry.text}` },
		);
	}
	return messages;
}

export async function answerLiveMeeting(
	{
		meetingBotId,
		question,
		speaker = "Participant",
		timestamp = 0,
	}: {
		meetingBotId: string;
		question: string;
		speaker?: string;
		timestamp?: number;
	},
	deps: ChatAgentDeps = {},
): Promise<string> {
	const document = await (deps.readTranscript ?? readLiveTranscript)(
		meetingBotId,
	);
	const context = liveContextAsText(document, CONTEXT_CHARS);
	const prompt = question.trim();
	const lower = prompt.toLowerCase();
	if (/^(note|action item)\s*:/i.test(prompt)) {
		const label = lower.startsWith("action item:") ? "Action item" : "Note";
		const text = prompt.replace(/^(note|action item)\s*:\s*/i, "").trim();
		if (!text) return "Please include the note text.";
		await (deps.appendCapture ?? appendCapture)(meetingBotId, {
			t: timestamp,
			speaker,
			text: `${label}: ${text}`,
		});
		return "Noted.";
	}
	if (!context) return "There is no transcript yet.";
	const botName = deps.botName ?? DEFAULT_BOT_NAME;
	const intent = /\b(action items?)\b/i.test(prompt)
		? "List the action items mentioned so far as short bullets, with owners when stated."
		: /\bcatch me up\b/i.test(prompt)
			? "Give a five-line recap of the meeting so far for someone who just joined."
			: /\b(summarize|summary)\b/i.test(prompt)
				? "Summarize the meeting so far in at most five short bullets."
				: null;
	return clipped(
		await (deps.answer ?? llmAnswer)(
			liveMeetingSystem(botName),
			[
				...meetingMessages(document, prompt),
				{ role: "user", content: intent ?? prompt },
			],
			{ webSearch: intent === null },
		),
	);
}

export async function handleLiveChatMessage(
	input: {
		meetingBotId: string;
		recallBotId: string;
		text: string;
		speaker: string;
		timestamp: number;
	},
	deps: ChatAgentDeps = {},
) {
	const config = deps.botName && deps.trigger ? null : getRecallConfig();
	const botName = deps.botName ?? config?.botName ?? DEFAULT_BOT_NAME;
	const trigger = deps.trigger ?? config?.agentTrigger ?? "/nt";
	if (input.speaker.trim().toLowerCase() === botName.trim().toLowerCase())
		return false;
	if (!isAgentMessage(input.text, trigger, botName)) return false;
	if (replies.has(input.recallBotId)) return false;
	replies.add(input.recallBotId);
	try {
		const message = await answerLiveMeeting(
			{
				meetingBotId: input.meetingBotId,
				question: messageWithoutInvocation(input.text, trigger, botName),
				speaker: input.speaker,
				timestamp: input.timestamp,
			},
			{ ...deps, botName },
		);
		await (
			deps.send ??
			((botId, params) =>
				getDefaultRecallClient().sendChatMessage(botId, params))
		)(input.recallBotId, { message });
		await (deps.appendChat ?? appendChat)(input.meetingBotId, {
			t: input.timestamp,
			speaker: botName,
			text: message,
			fromBot: true,
		});
		return true;
	} finally {
		replies.delete(input.recallBotId);
	}
}
