import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyRecallSignature } from "@/lib/recall/verify";

const secret = "whsec_dGVzdC1zZWNyZXQ";

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

describe("verifyRecallSignature", () => {
	const id = "msg_123";
	const payload = JSON.stringify({ event: "bot.status_change" });

	function freshHeaders(overrides: Record<string, string> = {}) {
		const timestamp = String(Math.floor(Date.now() / 1000));
		return {
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": sign({ id, timestamp, payload }),
			...overrides,
		};
	}

	it("passes for a validly signed payload", () => {
		expect(
			verifyRecallSignature({ secret, headers: freshHeaders(), payload }),
		).toBe(true);
	});

	it("passes when using svix-prefixed header names", () => {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const headers = {
			"svix-id": id,
			"svix-timestamp": timestamp,
			"svix-signature": sign({ id, timestamp, payload }),
		};
		expect(verifyRecallSignature({ secret, headers, payload })).toBe(true);
	});

	it("fails when the body is tampered with", () => {
		expect(
			verifyRecallSignature({
				secret,
				headers: freshHeaders(),
				payload: `${payload}x`,
			}),
		).toBe(false);
	});

	it("fails when a required header is missing", () => {
		const headers = freshHeaders();
		const { "webhook-signature": _omit, ...rest } = headers;
		expect(verifyRecallSignature({ secret, headers: rest, payload })).toBe(
			false,
		);
	});

	it("passes when one of several space-separated signatures is valid", () => {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const headers = {
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": `v1,bm90YXJlYWxzaWc= ${sign({ id, timestamp, payload })}`,
		};
		expect(verifyRecallSignature({ secret, headers, payload })).toBe(true);
	});

	it("fails for a stale timestamp", () => {
		const timestamp = String(Math.floor(Date.now() / 1000) - 60 * 10);
		const headers = {
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": sign({ id, timestamp, payload }),
		};
		expect(verifyRecallSignature({ secret, headers, payload })).toBe(false);
	});

	it("supports Headers instances", () => {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const headers = new Headers({
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": sign({ id, timestamp, payload }),
		});
		expect(verifyRecallSignature({ secret, headers, payload })).toBe(true);
	});
});
