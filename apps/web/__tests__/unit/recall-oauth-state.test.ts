import { describe, expect, it } from "vitest";
import { createOAuthState, verifyOAuthState } from "@/lib/recall/oauth-state";

describe("Recall OAuth state", () => {
	const secret = "client-secret";
	const now = 1720000000000;

	it("round-trips a signed, time-bounded state", () => {
		const state = createOAuthState({
			organizationId: "org123",
			userId: "user123",
			secret,
			now,
			nonce: "nonce123",
		});

		expect(verifyOAuthState({ state, secret, now })).toMatchObject({
			v: 1,
			organizationId: "org123",
			userId: "user123",
			issuedAt: 1720000000,
			nonce: "nonce123",
		});
	});

	it("rejects tampering, expiry, and states from the future", () => {
		const state = createOAuthState({
			organizationId: "org123",
			userId: "user123",
			secret,
			now,
			nonce: "nonce123",
		});
		expect(
			verifyOAuthState({
				state: `${state}x`,
				secret,
				now,
			}),
		).toBeNull();
		expect(
			verifyOAuthState({
				state,
				secret,
				now: now + 601_000,
			}),
		).toBeNull();
		expect(
			verifyOAuthState({
				state,
				secret,
				now: now - 61_000,
			}),
		).toBeNull();
	});

	it("rejects a state signed with a different secret", () => {
		const state = createOAuthState({
			organizationId: "org123",
			userId: "user123",
			secret,
			now,
		});
		expect(verifyOAuthState({ state, secret: "wrong-secret", now })).toBeNull();
	});
});
