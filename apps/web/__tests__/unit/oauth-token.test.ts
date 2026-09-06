import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAgentCodeChallenge } from "@/lib/agent-auth";
import {
	evaluateAuthorizationCodeGrant,
	evaluateRefreshTokenGrant,
	oauthAuthorizationServerMetadata,
	oauthProtectedResourceMetadata,
} from "@/lib/oauth";

const now = new Date("2026-09-06T12:00:00.000Z");
const verifier = `a${"b".repeat(42)}`;
const challenge = createHash("sha256").update(verifier).digest("base64url");

const publicClient = {
	id: "client_1",
	clientSecretHash: null,
	name: "Cursor",
	clientUri: null,
	logoUri: null,
	redirectUris: ["cursor://callback"],
	tokenEndpointAuthMethod: "none" as const,
	createdAt: now,
	lastUsedAt: null,
};

const grant = {
	id: "grant_1",
	userId: "user_1" as never,
	redirectUri: "cursor://callback",
	clientId: "client_1",
	codeChallenge: challenge,
	consumedAt: null,
	expiresAt: new Date(now.getTime() + 60_000),
	scopes: ["caps:read", "meetings:read"] as never,
};

const refresh = {
	id: "refresh_1",
	clientId: "client_1",
	revokedAt: null,
	expiresAt: new Date(now.getTime() + 60_000),
	accessTokenId: "access_1",
	userId: "user_1" as never,
	scopes: ["caps:read", "meetings:read"] as never,
};

describe("PKCE S256", () => {
	it("accepts a matching code_verifier", () => {
		expect(verifyAgentCodeChallenge(verifier, challenge)).toBe(true);
	});

	it("rejects a mismatched code_verifier", () => {
		expect(verifyAgentCodeChallenge(`z${"b".repeat(42)}`, challenge)).toBe(
			false,
		);
	});
});

describe("authorization_code grant", () => {
	it("exchanges a valid code after PKCE and redirect checks", () => {
		const result = evaluateAuthorizationCodeGrant({
			grant,
			client: publicClient,
			codeVerifier: verifier,
			redirectUri: "cursor://callback",
			clientId: "client_1",
			now,
		});
		expect(result).toEqual({ ok: true, grant, client: publicClient });
	});

	it("rejects a bad PKCE verifier", () => {
		const result = evaluateAuthorizationCodeGrant({
			grant,
			client: publicClient,
			codeVerifier: `z${"b".repeat(42)}`,
			redirectUri: "cursor://callback",
			clientId: "client_1",
			now,
		});
		expect(result).toMatchObject({
			ok: false,
			error: "invalid_grant",
			description: "PKCE verification failed",
		});
	});

	it("rejects a redirect_uri mismatch", () => {
		const result = evaluateAuthorizationCodeGrant({
			grant,
			client: publicClient,
			codeVerifier: verifier,
			redirectUri: "https://evil.example/callback",
			clientId: "client_1",
			now,
		});
		expect(result).toMatchObject({
			ok: false,
			error: "invalid_grant",
		});
	});
});

describe("refresh_token rotation", () => {
	it("accepts a live refresh token for the same client", () => {
		const result = evaluateRefreshTokenGrant({
			refresh,
			client: publicClient,
			clientId: "client_1",
			now,
		});
		expect(result).toEqual({ ok: true, refresh, client: publicClient });
	});

	it("rejects a revoked refresh token so rotation cannot reuse it", () => {
		const result = evaluateRefreshTokenGrant({
			refresh: { ...refresh, revokedAt: now },
			client: publicClient,
			clientId: "client_1",
			now,
		});
		expect(result).toMatchObject({
			ok: false,
			error: "invalid_grant",
		});
	});
});

describe("OAuth metadata shape", () => {
	const webUrl = "https://cap.example";

	it("describes the authorization server MCP clients expect", () => {
		expect(oauthAuthorizationServerMetadata(webUrl)).toEqual({
			issuer: webUrl,
			authorization_endpoint: `${webUrl}/oauth/authorize`,
			token_endpoint: `${webUrl}/api/oauth/token`,
			registration_endpoint: `${webUrl}/api/oauth/register`,
			revocation_endpoint: `${webUrl}/api/oauth/revoke`,
			code_challenge_methods_supported: ["S256"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			response_types_supported: ["code"],
			token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
			scopes_supported: expect.arrayContaining(["caps:read", "meetings:read"]),
		});
	});

	it("describes the MCP protected resource", () => {
		expect(oauthProtectedResourceMetadata(webUrl)).toEqual({
			resource: `${webUrl}/api/mcp`,
			authorization_servers: [webUrl],
			bearer_methods_supported: ["header"],
			scopes_supported: expect.arrayContaining(["caps:read", "meetings:read"]),
		});
	});
});
