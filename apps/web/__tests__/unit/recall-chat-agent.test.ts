import { describe, expect, it, vi } from "vitest";
import {
	answerLiveMeeting,
	handleLiveChatMessage,
} from "@/lib/recall/chat-agent";
import type { LiveTranscript } from "@/lib/recall/live-transcript";

const transcript: LiveTranscript = {
	version: 1,
	updatedAt: "2026-09-03T00:00:00.000Z",
	utterances: [
		{ t: 1, speaker: "Ada", text: "We will launch Friday." },
		{ t: 4, speaker: "Lin", text: "I will prepare the release notes." },
	],
	captures: [],
};

describe("answerLiveMeeting", () => {
	it.each(["summarize", "action items", "catch me up"])(
		"routes the %s intent through the LLM with an intent prompt",
		async (question) => {
			const answer = vi.fn().mockResolvedValue("- launch Friday");
			const response = await answerLiveMeeting(
				{ meetingBotId: "meeting_1", question },
				{ readTranscript: async () => transcript, answer },
			);

			expect(response).toBe("- launch Friday");
			expect(answer).toHaveBeenCalledTimes(1);
			const [system, prompt, options] = answer.mock.calls[0] ?? [];
			expect(system).toContain("launch Friday");
			expect(prompt).not.toBe(question);
			expect(prompt).toMatch(/meeting so far|action items/i);
			expect(options).toEqual({ webSearch: false });
		},
	);

	it("passes the live transcript and stripped question to the LLM", async () => {
		const answer = vi.fn().mockResolvedValue("The launch is Friday.");

		const response = await answerLiveMeeting(
			{ meetingBotId: "meeting_1", question: "When is the launch?" },
			{ readTranscript: async () => transcript, answer },
		);

		expect(response).toBe("The launch is Friday.");
		expect(answer).toHaveBeenCalledWith(
			expect.stringContaining("Ada: We will launch Friday."),
			"When is the launch?",
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
			"What's the weather in NYC?",
			{ webSearch: true },
		);
	});

	it("stores a note capture and replies Noted", async () => {
		const appendCapture = vi.fn().mockResolvedValue(undefined);
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
		};

		const first = handleLiveChatMessage(input, deps);
		await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
		await expect(handleLiveChatMessage(input, deps)).resolves.toBe(false);
		release?.("Friday.");
		await expect(first).resolves.toBe(true);
		expect(send).toHaveBeenCalledOnce();
	});
});
