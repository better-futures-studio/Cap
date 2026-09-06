import { timingSafeEqual } from "node:crypto";
import { nanoId } from "@cap/database/helpers";
import { oauthClients } from "@cap/database/schema";
import type { Agent, User } from "@cap/web-domain";
import {
	agentScopes,
	buildOauthCallbackUrl,
	createOauthClientSecret,
	hashAgentSecret,
	isAgentCodeChallenge,
	isOauthRedirectUri,
	parseOauthScopes,
	verifyAgentCodeChallenge,
} from "@/lib/agent-auth";

export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
export const OAUTH_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
export const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;

export const oauthCorsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers":
		"Authorization, Content-Type, MCP-Protocol-Version",
	"Access-Control-Max-Age": "86400",
} as const;

export const oauthJsonHeaders = {
	...oauthCorsHeaders,
	"Content-Type": "application/json; charset=utf-8",
	"Cache-Control": "no-store",
} as const;

export type OauthTokenErrorCode =
	| "invalid_request"
	| "invalid_client"
	| "invalid_grant"
	| "unauthorized_client"
	| "unsupported_grant_type"
	| "invalid_scope";

export type OauthTokenSuccess = {
	access_token: string;
	token_type: "Bearer";
	expires_in: number;
	refresh_token: string;
	scope: string;
};

export const oauthErrorBody = (
	error: OauthTokenErrorCode,
	description?: string,
) => ({
	error,
	...(description ? { error_description: description } : {}),
});

export const mcpProtectedResourcePath = (webUrl: string) =>
	`${stripTrailingSlash(webUrl)}/.well-known/oauth-protected-resource/api/mcp`;

export const mcpResourceUrl = (webUrl: string) =>
	`${stripTrailingSlash(webUrl)}/api/mcp`;

export const mcpWwwAuthenticate = (webUrl: string) =>
	`Bearer resource_metadata="${mcpProtectedResourcePath(webUrl)}"`;

export const oauthAuthorizationServerMetadata = (webUrl: string) => {
	const issuer = stripTrailingSlash(webUrl);
	return {
		issuer,
		authorization_endpoint: `${issuer}/oauth/authorize`,
		token_endpoint: `${issuer}/api/oauth/token`,
		registration_endpoint: `${issuer}/api/oauth/register`,
		revocation_endpoint: `${issuer}/api/oauth/revoke`,
		code_challenge_methods_supported: ["S256"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		response_types_supported: ["code"],
		token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
		scopes_supported: [...agentScopes],
	};
};

export const oauthProtectedResourceMetadata = (webUrl: string) => {
	const issuer = stripTrailingSlash(webUrl);
	return {
		resource: mcpResourceUrl(issuer),
		authorization_servers: [issuer],
		bearer_methods_supported: ["header"],
		scopes_supported: [...agentScopes],
	};
};

export function stripTrailingSlash(value: string) {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function clientHasRedirectUri(
	redirectUris: string[],
	redirectUri: string,
) {
	return redirectUris.includes(redirectUri);
}

export function parseRedirectUris(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const uris: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !isOauthRedirectUri(item)) return null;
		uris.push(item);
	}
	return uris;
}

export type OauthTokenEndpointAuthMethod = "none" | "client_secret_post";

export function parseTokenEndpointAuthMethod(
	value: unknown,
): OauthTokenEndpointAuthMethod | null {
	if (value === undefined || value === null || value === "") return "none";
	if (value === "none" || value === "client_secret_post") return value;
	return null;
}

export type RegisterOauthClientInput = {
	client_name?: unknown;
	redirect_uris?: unknown;
	client_uri?: unknown;
	logo_uri?: unknown;
	token_endpoint_auth_method?: unknown;
};

export type RegisterOauthClientResult =
	| {
			ok: true;
			status: 201;
			body: {
				client_id: string;
				client_secret?: string;
				client_name: string;
				redirect_uris: string[];
				client_uri: string | null;
				logo_uri: string | null;
				token_endpoint_auth_method: OauthTokenEndpointAuthMethod;
				grant_types: ["authorization_code", "refresh_token"];
				response_types: ["code"];
				client_id_issued_at: number;
			};
	  }
	| {
			ok: false;
			status: 400;
			body: { error: string; error_description: string };
	  };

export function validateRegisterOauthClient(input: RegisterOauthClientInput):
	| {
			ok: true;
			name: string;
			redirectUris: string[];
			clientUri: string | null;
			logoUri: string | null;
			tokenEndpointAuthMethod: OauthTokenEndpointAuthMethod;
	  }
	| { ok: false; error: string; error_description: string } {
	const name =
		typeof input.client_name === "string" ? input.client_name.trim() : "";
	if (!name || name.length > 255) {
		return {
			ok: false,
			error: "invalid_client_metadata",
			error_description: "client_name is required",
		};
	}
	const redirectUris = parseRedirectUris(input.redirect_uris);
	if (!redirectUris) {
		return {
			ok: false,
			error: "invalid_redirect_uri",
			error_description:
				"redirect_uris must be https, loopback http, or a custom scheme",
		};
	}
	const tokenEndpointAuthMethod = parseTokenEndpointAuthMethod(
		input.token_endpoint_auth_method,
	);
	if (!tokenEndpointAuthMethod) {
		return {
			ok: false,
			error: "invalid_client_metadata",
			error_description:
				"token_endpoint_auth_method must be none or client_secret_post",
		};
	}
	const clientUri =
		typeof input.client_uri === "string" && input.client_uri.trim()
			? input.client_uri.trim()
			: null;
	const logoUri =
		typeof input.logo_uri === "string" && input.logo_uri.trim()
			? input.logo_uri.trim()
			: null;
	if (clientUri && !isHttpsOrLoopbackUri(clientUri)) {
		return {
			ok: false,
			error: "invalid_client_metadata",
			error_description: "client_uri must be an https URL",
		};
	}
	if (logoUri && !isHttpsOrLoopbackUri(logoUri)) {
		return {
			ok: false,
			error: "invalid_client_metadata",
			error_description: "logo_uri must be an https URL",
		};
	}
	return {
		ok: true,
		name,
		redirectUris,
		clientUri,
		logoUri,
		tokenEndpointAuthMethod,
	};
}

function isHttpsOrLoopbackUri(value: string) {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" ||
			(url.protocol === "http:" &&
				(url.hostname === "127.0.0.1" ||
					url.hostname === "localhost" ||
					url.hostname === "[::1]"))
		);
	} catch {
		return false;
	}
}

export const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

type OauthClientRow = typeof oauthClients.$inferSelect;
type AuthCodeRow = {
	redirectUri: string;
	clientId: string | null;
	codeChallenge: string;
	consumedAt: Date | null;
	expiresAt: Date;
	userId: User.UserId;
	scopes: Agent.AgentScope[];
	id: string;
};
type RefreshTokenRow = {
	clientId: string;
	revokedAt: Date | null;
	expiresAt: Date;
	accessTokenId: string;
	userId: User.UserId;
	scopes: Agent.AgentScope[];
	id: string;
};

export function verifyOauthClientSecret(
	client: Pick<OauthClientRow, "clientSecretHash" | "tokenEndpointAuthMethod">,
	clientSecret: string | undefined,
) {
	if (client.tokenEndpointAuthMethod === "none") {
		return !clientSecret;
	}
	if (!client.clientSecretHash || !clientSecret) return false;
	const actual = Buffer.from(hashAgentSecret(clientSecret));
	const expected = Buffer.from(client.clientSecretHash);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type AuthorizationCodeGrantInput = {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	clientId: string;
	clientSecret?: string;
};

export type EvaluateAuthorizationCodeGrantResult =
	| { ok: true; grant: AuthCodeRow; client: OauthClientRow }
	| { ok: false; error: OauthTokenErrorCode; description: string };

export function evaluateAuthorizationCodeGrant(input: {
	grant: AuthCodeRow | undefined;
	client: OauthClientRow | undefined;
	codeVerifier: string;
	redirectUri: string;
	clientId: string;
	clientSecret?: string;
	now: Date;
}): EvaluateAuthorizationCodeGrantResult {
	if (!input.client || input.client.id !== input.clientId) {
		return {
			ok: false,
			error: "invalid_client",
			description: "Unknown client",
		};
	}
	if (!verifyOauthClientSecret(input.client, input.clientSecret)) {
		return {
			ok: false,
			error: "invalid_client",
			description: "Client authentication failed",
		};
	}
	if (
		!input.grant ||
		input.grant.redirectUri !== input.redirectUri ||
		input.grant.clientId !== input.clientId
	) {
		return {
			ok: false,
			error: "invalid_grant",
			description: "The authorization grant is invalid",
		};
	}
	if (
		input.grant.consumedAt ||
		input.grant.expiresAt.getTime() <= input.now.getTime()
	) {
		return {
			ok: false,
			error: "invalid_grant",
			description: "The authorization grant has expired",
		};
	}
	if (
		!verifyAgentCodeChallenge(input.codeVerifier, input.grant.codeChallenge)
	) {
		return {
			ok: false,
			error: "invalid_grant",
			description: "PKCE verification failed",
		};
	}
	return { ok: true, grant: input.grant, client: input.client };
}

export type EvaluateRefreshGrantResult =
	| {
			ok: true;
			refresh: RefreshTokenRow;
			client: OauthClientRow;
	  }
	| { ok: false; error: OauthTokenErrorCode; description: string };

export function evaluateRefreshTokenGrant(input: {
	refresh: RefreshTokenRow | undefined;
	client: OauthClientRow | undefined;
	clientId: string;
	clientSecret?: string;
	now: Date;
}): EvaluateRefreshGrantResult {
	if (!input.client || input.client.id !== input.clientId) {
		return {
			ok: false,
			error: "invalid_client",
			description: "Unknown client",
		};
	}
	if (!verifyOauthClientSecret(input.client, input.clientSecret)) {
		return {
			ok: false,
			error: "invalid_client",
			description: "Client authentication failed",
		};
	}
	if (
		!input.refresh ||
		input.refresh.clientId !== input.clientId ||
		input.refresh.revokedAt ||
		input.refresh.expiresAt.getTime() <= input.now.getTime()
	) {
		return {
			ok: false,
			error: "invalid_grant",
			description: "The refresh token is invalid",
		};
	}
	return { ok: true, refresh: input.refresh, client: input.client };
}

export function buildTokenSuccess(input: {
	accessToken: string;
	refreshToken: string;
	scopes: Agent.AgentScope[];
}): OauthTokenSuccess {
	return {
		access_token: input.accessToken,
		token_type: "Bearer",
		expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
		refresh_token: input.refreshToken,
		scope: input.scopes.join(" "),
	};
}

export async function registerOauthClient(
	db: {
		insert: (table: typeof oauthClients) => {
			values: (values: typeof oauthClients.$inferInsert) => Promise<unknown>;
		};
	},
	input: RegisterOauthClientInput,
): Promise<RegisterOauthClientResult> {
	const validated = validateRegisterOauthClient(input);
	if (!validated.ok) {
		return {
			ok: false,
			status: 400,
			body: {
				error: validated.error,
				error_description: validated.error_description,
			},
		};
	}
	const clientId = nanoId();
	const issuedAt = Math.floor(Date.now() / 1000);
	const confidential =
		validated.tokenEndpointAuthMethod === "client_secret_post";
	const clientSecret = confidential ? createOauthClientSecret() : undefined;
	await db.insert(oauthClients).values({
		id: clientId,
		clientSecretHash: clientSecret ? hashAgentSecret(clientSecret) : null,
		name: validated.name,
		clientUri: validated.clientUri,
		logoUri: validated.logoUri,
		redirectUris: validated.redirectUris,
		tokenEndpointAuthMethod: validated.tokenEndpointAuthMethod,
	});
	return {
		ok: true,
		status: 201,
		body: {
			client_id: clientId,
			...(clientSecret ? { client_secret: clientSecret } : {}),
			client_name: validated.name,
			redirect_uris: validated.redirectUris,
			client_uri: validated.clientUri,
			logo_uri: validated.logoUri,
			token_endpoint_auth_method: validated.tokenEndpointAuthMethod,
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			client_id_issued_at: issuedAt,
		},
	};
}

export function parseOauthFormBody(body: URLSearchParams) {
	const get = (key: string) => {
		const value = body.get(key);
		return value && value.length > 0 ? value : undefined;
	};
	return {
		grantType: get("grant_type"),
		code: get("code"),
		codeVerifier: get("code_verifier"),
		redirectUri: get("redirect_uri"),
		clientId: get("client_id"),
		clientSecret: get("client_secret"),
		refreshToken: get("refresh_token"),
		token: get("token"),
		tokenTypeHint: get("token_type_hint"),
		scope: get("scope"),
	};
}

export function scopesFromGrant(scopes: unknown): Agent.AgentScope[] | null {
	if (!Array.isArray(scopes)) return null;
	const parsed = parseOauthScopes(scopes.join(" "));
	return parsed && parsed.length > 0 ? parsed : null;
}

export { parseOauthScopes, isAgentCodeChallenge, buildOauthCallbackUrl };
