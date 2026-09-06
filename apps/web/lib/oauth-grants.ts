import "server-only";

import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	agentApiAuthorizationCodes,
	agentApiKeys,
	oauthClients,
	oauthRefreshTokens,
} from "@cap/database/schema";
import type { Agent, User } from "@cap/web-domain";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
	createAgentAccessToken,
	createOauthRefreshToken,
	hashAgentSecret,
} from "@/lib/agent-auth";
import {
	buildTokenSuccess,
	evaluateAuthorizationCodeGrant,
	evaluateRefreshTokenGrant,
	getAffectedRows,
	OAUTH_ACCESS_TOKEN_TTL_SECONDS,
	OAUTH_REFRESH_TOKEN_TTL_SECONDS,
	type OauthTokenErrorCode,
	type OauthTokenSuccess,
	scopesFromGrant,
} from "@/lib/oauth";

export type OauthGrantResult =
	| { ok: true; body: OauthTokenSuccess }
	| {
			ok: false;
			status: 400 | 401;
			error: OauthTokenErrorCode;
			description: string;
	  };

const tokenError = (
	error: OauthTokenErrorCode,
	description: string,
): OauthGrantResult => ({
	ok: false,
	status: error === "invalid_client" ? 401 : 400,
	error,
	description,
});

export async function exchangeOauthAuthorizationCode(input: {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	clientId: string;
	clientSecret?: string;
}): Promise<OauthGrantResult> {
	if (
		input.code.length < 32 ||
		input.code.length > 128 ||
		!input.clientId ||
		!input.redirectUri
	) {
		return tokenError("invalid_request", "Missing token request fields");
	}

	const now = new Date();
	const result = await db().transaction(async (tx) => {
		const [client] = await tx
			.select()
			.from(oauthClients)
			.where(eq(oauthClients.id, input.clientId))
			.limit(1);
		const [grant] = await tx
			.select()
			.from(agentApiAuthorizationCodes)
			.where(
				eq(agentApiAuthorizationCodes.codeHash, hashAgentSecret(input.code)),
			)
			.limit(1);
		const evaluated = evaluateAuthorizationCodeGrant({
			grant,
			client,
			codeVerifier: input.codeVerifier,
			redirectUri: input.redirectUri,
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			now,
		});
		if (!evaluated.ok) return evaluated;

		const scopes = scopesFromGrant(evaluated.grant.scopes);
		if (!scopes) {
			return {
				ok: false as const,
				error: "invalid_grant" as const,
				description: "The authorization grant is invalid",
			};
		}

		const consumed = await tx
			.update(agentApiAuthorizationCodes)
			.set({ consumedAt: now })
			.where(
				and(
					eq(agentApiAuthorizationCodes.id, evaluated.grant.id),
					isNull(agentApiAuthorizationCodes.consumedAt),
					gt(agentApiAuthorizationCodes.expiresAt, now),
				),
			);
		if (getAffectedRows(consumed) !== 1) {
			return {
				ok: false as const,
				error: "invalid_grant" as const,
				description: "The authorization grant has expired",
			};
		}

		const issued = await issueOauthTokens(tx, {
			userId: evaluated.grant.userId,
			clientId: evaluated.client.id,
			clientName: evaluated.client.name,
			scopes,
			now,
		});
		await tx
			.update(oauthClients)
			.set({ lastUsedAt: now })
			.where(eq(oauthClients.id, evaluated.client.id));
		return { ok: true as const, body: issued };
	});

	if (!result.ok) return tokenError(result.error, result.description);
	return { ok: true, body: result.body };
}

export async function rotateOauthRefreshToken(input: {
	refreshToken: string;
	clientId: string;
	clientSecret?: string;
}): Promise<OauthGrantResult> {
	if (!input.refreshToken || !input.clientId) {
		return tokenError("invalid_request", "Missing token request fields");
	}

	const now = new Date();
	const result = await db().transaction(async (tx) => {
		const [client] = await tx
			.select()
			.from(oauthClients)
			.where(eq(oauthClients.id, input.clientId))
			.limit(1);
		const [refresh] = await tx
			.select()
			.from(oauthRefreshTokens)
			.where(
				eq(oauthRefreshTokens.tokenHash, hashAgentSecret(input.refreshToken)),
			)
			.limit(1);
		const evaluated = evaluateRefreshTokenGrant({
			refresh,
			client,
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			now,
		});
		if (!evaluated.ok) return evaluated;

		const revokedRefresh = await tx
			.update(oauthRefreshTokens)
			.set({ revokedAt: now })
			.where(
				and(
					eq(oauthRefreshTokens.id, evaluated.refresh.id),
					isNull(oauthRefreshTokens.revokedAt),
					gt(oauthRefreshTokens.expiresAt, now),
				),
			);
		if (getAffectedRows(revokedRefresh) !== 1) {
			return {
				ok: false as const,
				error: "invalid_grant" as const,
				description: "The refresh token is invalid",
			};
		}

		await tx
			.update(agentApiKeys)
			.set({ revokedAt: now })
			.where(
				and(
					eq(agentApiKeys.id, evaluated.refresh.accessTokenId),
					isNull(agentApiKeys.revokedAt),
				),
			);

		const scopes =
			scopesFromGrant(evaluated.refresh.scopes) ?? evaluated.refresh.scopes;
		const issued = await issueOauthTokens(tx, {
			userId: evaluated.refresh.userId,
			clientId: evaluated.client.id,
			clientName: evaluated.client.name,
			scopes,
			now,
		});
		await tx
			.update(oauthClients)
			.set({ lastUsedAt: now })
			.where(eq(oauthClients.id, evaluated.client.id));
		return { ok: true as const, body: issued };
	});

	if (!result.ok) return tokenError(result.error, result.description);
	return { ok: true, body: result.body };
}

export async function revokeOauthToken(input: {
	token: string;
	clientId?: string;
	clientSecret?: string;
	tokenTypeHint?: string;
}): Promise<void> {
	if (!input.token) return;
	const now = new Date();
	const tokenHash = hashAgentSecret(input.token);
	const hint = input.tokenTypeHint;

	if (hint !== "refresh_token") {
		const [key] = await db()
			.select({
				id: agentApiKeys.id,
				oauthClientId: agentApiKeys.oauthClientId,
			})
			.from(agentApiKeys)
			.where(
				and(
					eq(agentApiKeys.tokenHash, tokenHash),
					isNull(agentApiKeys.revokedAt),
				),
			)
			.limit(1);
		if (key) {
			if (
				input.clientId &&
				key.oauthClientId &&
				key.oauthClientId !== input.clientId
			) {
				return;
			}
			await db()
				.update(agentApiKeys)
				.set({ revokedAt: now })
				.where(eq(agentApiKeys.id, key.id));
			await db()
				.update(oauthRefreshTokens)
				.set({ revokedAt: now })
				.where(
					and(
						eq(oauthRefreshTokens.accessTokenId, key.id),
						isNull(oauthRefreshTokens.revokedAt),
					),
				);
			return;
		}
	}

	if (hint !== "access_token") {
		const [refresh] = await db()
			.select()
			.from(oauthRefreshTokens)
			.where(
				and(
					eq(oauthRefreshTokens.tokenHash, tokenHash),
					isNull(oauthRefreshTokens.revokedAt),
				),
			)
			.limit(1);
		if (!refresh) return;
		if (input.clientId && refresh.clientId !== input.clientId) return;
		await db()
			.update(oauthRefreshTokens)
			.set({ revokedAt: now })
			.where(eq(oauthRefreshTokens.id, refresh.id));
		await db()
			.update(agentApiKeys)
			.set({ revokedAt: now })
			.where(
				and(
					eq(agentApiKeys.id, refresh.accessTokenId),
					isNull(agentApiKeys.revokedAt),
				),
			);
	}
}

type DbTransaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

async function issueOauthTokens(
	tx: DbTransaction,
	input: {
		userId: User.UserId;
		clientId: string;
		clientName: string;
		scopes: Agent.AgentScope[];
		now: Date;
	},
) {
	const accessToken = createAgentAccessToken();
	const refreshToken = createOauthRefreshToken();
	const accessTokenId = nanoId();
	const accessExpiresAt = new Date(
		input.now.getTime() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000,
	);
	const refreshExpiresAt = new Date(
		input.now.getTime() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000,
	);

	await tx.insert(agentApiKeys).values({
		id: accessTokenId,
		userId: input.userId,
		tokenHash: hashAgentSecret(accessToken),
		name: input.clientName.slice(0, 100),
		scopes: input.scopes,
		oauthClientId: input.clientId,
		expiresAt: accessExpiresAt,
	});
	await tx.insert(oauthRefreshTokens).values({
		id: nanoId(),
		tokenHash: hashAgentSecret(refreshToken),
		accessTokenId,
		clientId: input.clientId,
		userId: input.userId,
		scopes: input.scopes,
		expiresAt: refreshExpiresAt,
	});

	return buildTokenSuccess({
		accessToken,
		refreshToken,
		scopes: input.scopes,
	});
}

export async function findOauthClient(clientId: string) {
	const [client] = await db()
		.select()
		.from(oauthClients)
		.where(eq(oauthClients.id, clientId))
		.limit(1);
	return client ?? null;
}
