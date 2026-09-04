import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const secret = "whsec_dGVzdC1zZWNyZXQ";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	dispatch: vi.fn(),
	start: vi.fn(),
	insertedIds: new Set<string>(),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/schema", () => ({
	recallWebhookEvents: {
		table: "recall_webhook_events",
		id: "recall_webhook_events.id",
		event: "recall_webhook_events.event",
	},
}));
vi.mock("@/lib/recall/config", () => ({
	DEFAULT_BOT_NAME: "Meeting Notetaker",
	getRecallConfig: () => ({
		apiKey: "test-api-key",
		region: "us-west-2",
		baseUrl: "https://us-west-2.recall.ai",
		verificationSecret: "whsec_dGVzdC1zZWNyZXQ",
		botName: "Meeting Notetaker",
		publicBaseUrl: "https://cap.example.com",
		calendarGoogle: null,
	}),
}));
vi.mock("@/lib/recall/webhooks", () => ({
	dispatchRecallWebhook: mocks.dispatch,
}));
vi.mock("workflow/api", () => ({
	start: mocks.start,
}));

import { POST } from "@/app/api/webhooks/recall/route";

function sign({
	id,
	timestamp,
	payload,
}: {
	id: string;
	timestamp: string;
	payload: string;
}): string {
	const key = Buffer.from(secret.slice("whsec_".length), "base64");
	const signature = createHmac("sha256", key)
		.update(`${id}.${timestamp}.${payload}`)
		.digest("base64");
	return `v1,${signature}`;
}

function createDb() {
	return {
		insert() {
			return {
				ignore() {
					return {
						values: async (values: { id: string; event: string }) => {
							if (mocks.insertedIds.has(values.id)) {
								return [{ affectedRows: 0 }];
							}
							mocks.insertedIds.add(values.id);
							return [{ affectedRows: 1 }];
						},
					};
				},
			};
		},
	};
}

function signedRequest(
	payload: string,
	overrides: Record<string, string> = {},
	id = "msg_123",
) {
	const timestamp = String(Math.floor(Date.now() / 1000));
	return new NextRequest("https://cap.example.com/api/webhooks/recall", {
		method: "POST",
		body: payload,
		headers: {
			"content-type": "application/json",
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": sign({ id, timestamp, payload }),
			...overrides,
		},
	});
}

const payload = JSON.stringify({
	event: "bot.status_change",
	data: {
		bot: { id: "bot_1" },
		data: { code: "joining_call", sub_code: null },
	},
});

beforeEach(() => {
	mocks.insertedIds.clear();
	mocks.db.mockReturnValue(createDb());
	mocks.dispatch.mockResolvedValue(undefined);
});

describe("POST /api/webhooks/recall", () => {
	it("returns 401 and does not dispatch for a bad signature", async () => {
		const response = await POST(
			signedRequest(payload, { "webhook-signature": "v1,bm90YXJlYWxzaWc=" }),
		);

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({
			error: "invalid signature",
		});
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("returns 200 and dispatches once for a valid signature", async () => {
		const response = await POST(signedRequest(payload));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ accepted: true });
		expect(mocks.dispatch).toHaveBeenCalledOnce();
		expect(mocks.dispatch).toHaveBeenCalledWith({
			event: "bot.status_change",
			data: {
				bot: { id: "bot_1" },
				data: { code: "joining_call", sub_code: null },
			},
		});
	});

	it("returns duplicate and does not dispatch the second time", async () => {
		const first = await POST(signedRequest(payload));
		expect(first.status).toBe(200);
		expect(mocks.dispatch).toHaveBeenCalledOnce();

		const second = await POST(signedRequest(payload));
		expect(second.status).toBe(200);
		await expect(second.json()).resolves.toEqual({ duplicate: true });
		expect(mocks.dispatch).toHaveBeenCalledOnce();
	});

	it("still returns 200 when dispatch throws", async () => {
		mocks.dispatch.mockRejectedValueOnce(new Error("boom"));

		const response = await POST(signedRequest(payload, {}, "msg_throw"));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ accepted: false });
		expect(mocks.dispatch).toHaveBeenCalledOnce();
	});
});
