import { generateText } from "ai";
import { runWithAiProviders } from "@/lib/ai/run";
import { getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";
import {
	appendCapture,
	type LiveTranscript,
	liveTranscriptAsText,
	readLiveTranscript,
} from "./live-transcript";

const MAX_REPLY_CHARS = 600;

export type ChatAgentDeps = {
	readTranscript?: (meetingBotId: string) => Promise<LiveTranscript | null>;
	appendCapture?: (
		meetingBotId: string,
		capture: { t: number; speaker: string; text: string },
	) => Promise<void>;
	answer?: (system: string, prompt: string) => Promise<string>;
	send?: (botId: string, params: { message: string }) => Promise<void>;
	botName?: string;
	trigger?: string;
};

const replies = new Set<string>();

function clipped(text: string) {
	return text.trim().slice(0, MAX_REPLY_CHARS);
}

async function llmAnswer(system: string, prompt: string) {
	return runWithAiProviders("chat", async (selection) => {
		const result = await generateText({
			model: selection.model(),
			system,
			prompt,
			maxOutputTokens: selection.defaultMaxOutputTokens,
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
	const transcript = liveTranscriptAsText(document, 12_000);
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
	if (!transcript) return "There is no transcript yet.";
	const intent = /\b(action items?)\b/i.test(prompt)
		? "List the action items mentioned so far as short bullets, with owners when stated."
		: /\bcatch me up\b/i.test(prompt)
			? "Give a five-line recap of the meeting so far for someone who just joined."
			: /\b(summarize|summary)\b/i.test(prompt)
				? "Summarize the meeting so far in at most five short bullets."
				: null;
	const system =
		"You are Boca Pro Notetaker, in a live meeting. Answer briefly (max ~600 chars) using only the transcript so far. If the answer is not in the transcript, say so.";
	return clipped(
		await (deps.answer ?? llmAnswer)(
			`${system}\n\nTranscript:\n${transcript}`,
			intent ?? prompt,
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
	const botName = deps.botName ?? config?.botName ?? "Boca Pro Notetaker";
	const trigger = deps.trigger ?? config?.agentTrigger ?? "@notetaker";
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
			deps,
		);
		await (
			deps.send ??
			((botId, params) =>
				getDefaultRecallClient().sendChatMessage(botId, params))
		)(input.recallBotId, { message });
		return true;
	} finally {
		replies.delete(input.recallBotId);
	}
}
