import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const secret = "whsec_dGVzdC1zZWNyZXQ";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	insertedIds: new Set<string>(),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/schema", () => ({
	meetingBots: {
		id: "meeting_bots.id",
		recallBotId: "meeting_bots.recallBotId",
	},
	recallWebhookEvents: {
		id: "recall_webhook_events.id",
		event: "recall_webhook_events.event",
	},
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn((left, right) => [left, right]) }));
vi.mock("@/lib/recall/config", () => ({
	getRecallConfig: () => ({
		verificationSecret: secret,
		botName: "Boca Pro Notetaker",
		agentTrigger: "/nt",
	}),
}));

import { POST } from "@/app/api/webhooks/recall/realtime/route";
import { handleRealtimeEvent } from "@/lib/recall/realtime";

function createDb() {
	return {
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [{ id: "meeting_1" }] }),
			}),
		}),
		insert: () => ({
			ignore: () => ({
				values: async (values: { id: string }) => {
					if (mocks.insertedIds.has(values.id)) return [{ affectedRows: 0 }];
					mocks.insertedIds.add(values.id);
					return [{ affectedRows: 1 }];
				},
			}),
		}),
		delete: () => ({ where: async () => undefined }),
	};
}

function sign(id: string, timestamp: string, payload: string) {
	const key = Buffer.from(secret.slice("whsec_".length), "base64");
	const signature = createHmac("sha256", key)
		.update(`${id}.${timestamp}.${payload}`)
		.digest("base64");
	return `v1,${signature}`;
}

function signedRequest(payload: string, id = "realtime_1") {
	const timestamp = String(Math.floor(Date.now() / 1000));
	return new NextRequest("https://cap.boca.pro/api/webhooks/recall/realtime/", {
		method: "POST",
		body: payload,
		headers: {
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": sign(id, timestamp, payload),
		},
	});
}

function transcriptPayload() {
	return {
		event: "transcript.data",
		data: {
			bot: { id: "recall_bot_1" },
			data: {
				participant: { name: "Ada" },
				words: [
					{
						text: "Launch",
						start_timestamp: { relative: 42.5 },
						end_timestamp: { relative: 42.8 },
					},
					{
						text: "Friday",
						start_timestamp: { relative: 42.9 },
						end_timestamp: null,
					},
				],
			},
		},
	};
}

function chatPayload(text: string, speaker = "Ada") {
	return {
		event: "participant_events.chat_message",
		data: {
			bot: { id: "recall_bot_1" },
			data: {
				action: "chat_message",
				participant: { name: speaker },
				timestamp: { relative: 51.25 },
				data: { text, to: "everyone" },
			},
		},
	};
}

beforeEach(() => {
	mocks.insertedIds.clear();
	mocks.db.mockReturnValue(createDb());
});

describe("POST /api/webhooks/recall/realtime", () => {
	it("requires a valid raw-body signature", async () => {
		const payload = JSON.stringify({ event: "unknown", data: {} });
		const response = await POST(
			new NextRequest("https://cap.boca.pro/api/webhooks/recall/realtime/", {
				method: "POST",
				body: payload,
			}),
		);

		expect(response.status).toBe(401);
	});

	it("accepts a payload signed from its exact raw body", async () => {
		const payload = JSON.stringify({
			event: "unknown",
			data: { bot: { id: "recall_bot_1" }, data: {} },
		});
		const response = await POST(signedRequest(payload));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ accepted: true });
	});

	it("deduplicates repeated webhook ids", async () => {
		const payload = JSON.stringify({
			event: "unknown",
			data: { bot: { id: "recall_bot_1" }, data: {} },
		});

		expect(
			(await POST(signedRequest(payload, "realtime_duplicate"))).status,
		).toBe(200);
		const duplicate = await POST(signedRequest(payload, "realtime_duplicate"));

		expect(duplicate.status).toBe(200);
		await expect(duplicate.json()).resolves.toEqual({ duplicate: true });
	});
});

describe("handleRealtimeEvent", () => {
	it("appends finalized transcript words with speaker and relative time", async () => {
		const appendUtterance = vi.fn().mockResolvedValue(undefined);

		await handleRealtimeEvent(transcriptPayload(), { appendUtterance });

		expect(appendUtterance).toHaveBeenCalledOnce();
		expect(appendUtterance).toHaveBeenCalledWith("meeting_1", {
			t: 42.5,
			speaker: "Ada",
			text: "Launch Friday",
		});
	});

	it("answers a triggered chat message and sends one Recall reply", async () => {
		const appendChat = vi.fn().mockResolvedValue(undefined);
		const answer = vi.fn().mockResolvedValue("Friday.");
		const send = vi.fn().mockResolvedValue(undefined);

		await handleRealtimeEvent(chatPayload("/Nt when is launch?"), {
			appendChat,
			chatAgent: {
				botName: "Boca Pro Notetaker",
				trigger: "/nt",
				readTranscript: async () => ({
					version: 1,
					updatedAt: "2026-09-03T00:00:00.000Z",
					utterances: [{ t: 42.5, speaker: "Ada", text: "Launch Friday" }],
					captures: [],
					chat: [],
				}),
				appendChat,
				answer,
				send,
			},
		});

		expect(appendChat).toHaveBeenCalledWith("meeting_1", {
			t: 51.25,
			speaker: "Ada",
			text: "/Nt when is launch?",
			fromBot: false,
		});
		expect(answer).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith("recall_bot_1", { message: "Friday." });
		expect(appendChat).toHaveBeenLastCalledWith("meeting_1", {
			t: 51.25,
			speaker: "Boca Pro Notetaker",
			text: "Friday.",
			fromBot: true,
		});
	});

	it("appends non-trigger chat messages without answering", async () => {
		const appendChat = vi.fn().mockResolvedValue(undefined);
		const answer = vi.fn();
		const send = vi.fn();

		await handleRealtimeEvent(chatPayload("when is launch?"), {
			appendChat,
			chatAgent: {
				botName: "Boca Pro Notetaker",
				trigger: "/nt",
				answer,
				send,
			},
		});

		expect(appendChat).toHaveBeenCalledOnce();
		expect(appendChat).toHaveBeenCalledWith("meeting_1", {
			t: 51.25,
			speaker: "Ada",
			text: "when is launch?",
			fromBot: false,
		});
		expect(answer).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("does not append the bot's own chat messages", async () => {
		const appendChat = vi.fn();
		const answer = vi.fn();
		const send = vi.fn();

		await handleRealtimeEvent(
			chatPayload("/nt summarize", "Boca Pro Notetaker"),
			{
				appendChat,
				chatAgent: {
					botName: "Boca Pro Notetaker",
					trigger: "/nt",
					answer,
					send,
				},
			},
		);

		expect(appendChat).not.toHaveBeenCalled();
		expect(answer).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("passes prior chat exchanges when answering a follow-up", async () => {
		const document = {
			version: 1 as const,
			updatedAt: "2026-09-03T00:00:00.000Z",
			utterances: [] as { t: number; speaker: string; text: string }[],
			captures: [] as { t: number; speaker: string; text: string }[],
			chat: [] as {
				t: number;
				speaker: string;
				text: string;
				fromBot: boolean;
			}[],
		};
		const appendChat = vi.fn(
			async (
				_id: string,
				entry: {
					t: number;
					speaker: string;
					text: string;
					fromBot: boolean;
				},
			) => {
				document.chat.push(entry);
			},
		);
		const answer = vi
			.fn()
			.mockResolvedValueOnce("Sunny and 82F in Tampa.")
			.mockResolvedValueOnce("No, it is not raining in Tampa.");
		const send = vi.fn().mockResolvedValue(undefined);
		const deps = {
			appendChat,
			chatAgent: {
				botName: "Boca Pro Notetaker",
				trigger: "/nt",
				readTranscript: async () => document,
				appendChat,
				answer,
				send,
			},
		};

		await handleRealtimeEvent(
			chatPayload("/nt what's the weather in tampa"),
			deps,
		);
		await handleRealtimeEvent(chatPayload("/nt is it raining now?"), deps);

		expect(answer).toHaveBeenCalledTimes(2);
		const secondMessages = answer.mock.calls[1]?.[1] ?? [];
		expect(JSON.stringify(secondMessages)).toMatch(/weather in tampa/i);
		expect(secondMessages.at(-1)).toEqual({
			role: "user",
			content: "is it raining now?",
		});
	});

	it("can defer chat work for a fast webhook response", async () => {
		const deferChat = vi.fn();
		const handleChatMessage = vi.fn();

		await handleRealtimeEvent(chatPayload("/nt summarize"), {
			deferChat,
			handleChatMessage,
		});

		expect(deferChat).toHaveBeenCalledOnce();
		expect(handleChatMessage).not.toHaveBeenCalled();
	});
});
