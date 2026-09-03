import { describe, expect, it, vi } from "vitest";
import {
	answerLiveMeeting,
	handleLiveChatMessage,
} from "@/lib/recall/chat-agent";
import {
	type LiveTranscript,
	liveContextAsText,
} from "@/lib/recall/live-transcript";

const transcript: LiveTranscript = {
	version: 1,
	updatedAt: "2026-09-03T00:00:00.000Z",
	utterances: [
		{ t: 1, speaker: "Ada", text: "We will launch Friday." },
		{ t: 4, speaker: "Lin", text: "I will prepare the release notes." },
	],
	captures: [],
	chat: [],
};

function lastContent(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	const last = messages.at(-1);
	if (!last || typeof last !== "object" || !("content" in last)) return "";
	return typeof last.content === "string" ? last.content : "";
}

describe("liveContextAsText", () => {
	it("merges spoken utterances and chat in chronological order", () => {
		const text = liveContextAsText(
			{
				version: 1,
				updatedAt: "2026-09-03T00:00:00.000Z",
				utterances: [{ t: 5, speaker: "Ada", text: "Launch Friday" }],
				captures: [],
				chat: [
					{ t: 2, speaker: "Lin", text: "hello everyone", fromBot: false },
					{
						t: 8,
						speaker: "Boca Pro Notetaker",
						text: "Noted.",
						fromBot: true,
					},
				],
			},
			12_000,
		);

		expect(text).toBe(
			"[chat] Lin: hello everyone\nAda: Launch Friday\n[chat] Notetaker: Noted.",
		);
	});

	it("loads old documents that have no chat array", () => {
		expect(
			liveContextAsText(
				{
					version: 1,
					updatedAt: "2026-09-03T00:00:00.000Z",
					utterances: [{ t: 1, speaker: "Ada", text: "Hi" }],
					captures: [],
				},
				12_000,
			),
		).toBe("Ada: Hi");
	});

	it("trims oldest characters first", () => {
		const text = liveContextAsText(
			{
				version: 1,
				updatedAt: "2026-09-03T00:00:00.000Z",
				utterances: [
					{ t: 1, speaker: "Ada", text: "AAAA" },
					{ t: 2, speaker: "Lin", text: "BBBB" },
				],
				captures: [],
			},
			10,
		);

		expect(text.length).toBe(10);
		expect(text.endsWith("BBBB")).toBe(true);
	});
});

describe("answerLiveMeeting", () => {
	it.each(["summarize", "action items", "catch me up"])(
		"routes the %s intent through the LLM with meeting context",
		async (question) => {
			const answer = vi.fn().mockResolvedValue("- launch Friday");
			const response = await answerLiveMeeting(
				{ meetingBotId: "meeting_1", question },
				{ readTranscript: async () => transcript, answer },
			);

			expect(response).toBe("- launch Friday");
			expect(answer).toHaveBeenCalledTimes(1);
			const [system, messages, options] = answer.mock.calls[0] ?? [];
			expect(system).toContain("use web search");
			expect(JSON.stringify(messages)).toContain("launch Friday");
			expect(lastContent(messages)).not.toBe(question);
			expect(lastContent(messages)).toMatch(/meeting so far|action items/i);
			expect(options).toEqual({ webSearch: false });
		},
	);

	it("passes the live transcript and stripped question as messages", async () => {
		const answer = vi.fn().mockResolvedValue("The launch is Friday.");

		const response = await answerLiveMeeting(
			{ meetingBotId: "meeting_1", question: "When is the launch?" },
			{ readTranscript: async () => transcript, answer },
		);

		expect(response).toBe("The launch is Friday.");
		expect(answer).toHaveBeenCalledWith(
			expect.stringContaining("use web search"),
			expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					content: expect.stringContaining("Ada: We will launch Friday."),
				}),
				expect.objectContaining({
					role: "user",
					content: "When is the launch?",
				}),
			]),
			{ webSearch: true },
		);
	});

	it("allows web search for general questions and keeps the new system prompt", async () => {
		const answer = vi.fn().mockResolvedValue("Sunny, about 72F.");

		const response = await answerLiveMeeting(
			{ meetingBotId: "meeting_1", question: "What's the weather in NYC?" },
			{ readTranscript: async () => transcript, answer },
		);

		expect(response).toBe("Sunny, about 72F.");
		expect(answer).toHaveBeenCalledWith(
			expect.stringContaining("use web search"),
			expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					content: "What's the weather in NYC?",
				}),
			]),
			{ webSearch: true },
		);
	});

	it("includes prior chat exchanges when answering a follow-up", async () => {
		const answer = vi.fn().mockResolvedValue("No, it is not raining.");
		const document: LiveTranscript = {
			...transcript,
			chat: [
				{
					t: 10,
					speaker: "Ada",
					text: "/nt what's the weather in tampa",
					fromBot: false,
				},
				{
					t: 11,
					speaker: "Boca Pro Notetaker",
					text: "Sunny and 82F in Tampa.",
					fromBot: true,
				},
				{
					t: 20,
					speaker: "Ada",
					text: "/nt is it raining now?",
					fromBot: false,
				},
			],
		};

		await answerLiveMeeting(
			{ meetingBotId: "meeting_1", question: "is it raining now?" },
			{ readTranscript: async () => document, answer },
		);

		const messages = answer.mock.calls[0]?.[1] ?? [];
		expect(JSON.stringify(messages)).toMatch(/weather in tampa/i);
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					content: "Ada: /nt what's the weather in tampa",
				}),
				expect.objectContaining({
					role: "assistant",
					content: "Sunny and 82F in Tampa.",
				}),
				expect.objectContaining({
					role: "user",
					content: "is it raining now?",
				}),
			]),
		);
		expect(lastContent(messages)).toBe("is it raining now?");
	});

	it("stores a note capture and replies Noted", async () => {
		const appendCapture = vi.fn().mockResolvedValue(undefined);
		const appendChat = vi.fn().mockResolvedValue(undefined);
		const send = vi.fn().mockResolvedValue(undefined);
		const answer = vi.fn();

		await handleLiveChatMessage(
			{
				meetingBotId: "meeting_1",
				recallBotId: "recall_bot_1",
				text: "/nt note: Follow up with Ada",
				speaker: "Lin",
				timestamp: 18.5,
			},
			{
				botName: "Boca Pro Notetaker",
				trigger: "/nt",
				readTranscript: async () => transcript,
				appendCapture,
				appendChat,
				answer,
				send,
			},
		);

		expect(appendCapture).toHaveBeenCalledWith("meeting_1", {
			t: 18.5,
			speaker: "Lin",
			text: "Note: Follow up with Ada",
		});
		expect(answer).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith("recall_bot_1", { message: "Noted." });
		expect(appendChat).toHaveBeenCalledWith("meeting_1", {
			t: 18.5,
			speaker: "Boca Pro Notetaker",
			text: "Noted.",
			fromBot: true,
		});
	});

	it("allows only one in-flight reply per bot", async () => {
		let release: ((value: string) => void) | undefined;
		const answer = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
		);
		const send = vi.fn().mockResolvedValue(undefined);
		const appendChat = vi.fn().mockResolvedValue(undefined);
		const input = {
			meetingBotId: "meeting_1",
			recallBotId: "recall_bot_1",
			text: "/nt when is launch?",
			speaker: "Ada",
			timestamp: 20,
		};
		const deps = {
			botName: "Boca Pro Notetaker",
			trigger: "/nt",
			readTranscript: async () => transcript,
			answer,
			send,
			appendChat,
		};

		const first = handleLiveChatMessage(input, deps);
		await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
		await expect(handleLiveChatMessage(input, deps)).resolves.toBe(false);
		release?.("Friday.");
		await expect(first).resolves.toBe(true);
		expect(send).toHaveBeenCalledOnce();
		expect(appendChat).toHaveBeenCalledOnce();
	});
});
