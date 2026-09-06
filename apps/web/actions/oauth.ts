"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	agentApiAuthorizationCodes,
	agentApiKeys,
	oauthAuthorizationRequests,
	oauthClients,
	oauthRefreshTokens,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import {
	createAgentAuthorizationCode,
	hashAgentSecret,
	isAgentCodeChallenge,
	parseOauthScopes,
} from "@/lib/agent-auth";
import {
	buildOauthCallbackUrl,
	clientHasRedirectUri,
	getAffectedRows,
	mcpResourceUrl,
	OAUTH_AUTHORIZATION_TTL_MS,
	OAUTH_CODE_TTL_MS,
} from "@/lib/oauth";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export type PendingAuthorization = {
	requestId: string;
	clientName: string;
	clientUri: string | null;
	scopes: string[];
	redirectHost: string;
	expiresAt: string;
};

async function requireUser() {
	const user = await getCurrentUser();
	if (!user) throw new Error("Sign in required");
	return user;
}

export async function createPendingAuthorization(input: {
	clientId: string;
	redirectUri: string;
	scope?: string;
	state?: string;
	codeChallenge: string;
	codeChallengeMethod: "S256";
	resource?: string;
}): Promise<{ requestId: string } | { error: string }> {
	const user = await getCurrentUser();
	if (!user) return { error: "Sign in required" };

	if (
		await isRateLimited(RATE_LIMIT_IDS.AGENT_AUTHORIZATION, {
			key: `oauth-authorization:${user.id}`,
		})
	) {
		return { error: "Too many authorization attempts. Try again later." };
	}

	if (input.codeChallengeMethod !== "S256") {
		return { error: "code_challenge_method must be S256" };
	}
	if (!isAgentCodeChallenge(input.codeChallenge)) {
		return { error: "Invalid code_challenge" };
	}
	const scopes = parseOauthScopes(input.scope);
	if (!scopes) return { error: "Invalid scope" };

	const [client] = await db()
		.select()
		.from(oauthClients)
		.where(eq(oauthClients.id, input.clientId))
		.limit(1);
	if (!client) return { error: "Unknown client" };
	if (!clientHasRedirectUri(client.redirectUris, input.redirectUri)) {
		return { error: "redirect_uri is not registered for this client" };
	}
	if (
		input.resource &&
		input.resource !== mcpResourceUrl(serverEnv().WEB_URL)
	) {
		return { error: "Invalid resource" };
	}

	const requestId = nanoId();
	await db()
		.insert(oauthAuthorizationRequests)
		.values({
			id: requestId,
			clientId: client.id,
			redirectUri: input.redirectUri,
			scope: scopes.join(" "),
			state: input.state ?? null,
			codeChallenge: input.codeChallenge,
			resource: input.resource ?? null,
			status: "pending",
			expiresAt: new Date(Date.now() + OAUTH_AUTHORIZATION_TTL_MS),
		});
	return { requestId };
}

export async function getPendingAuthorization(input: {
	requestId: string;
}): Promise<PendingAuthorization | null> {
	await requireUser();
	const [row] = await db()
		.select({
			id: oauthAuthorizationRequests.id,
			redirectUri: oauthAuthorizationRequests.redirectUri,
			scope: oauthAuthorizationRequests.scope,
			expiresAt: oauthAuthorizationRequests.expiresAt,
			status: oauthAuthorizationRequests.status,
			clientName: oauthClients.name,
			clientUri: oauthClients.clientUri,
		})
		.from(oauthAuthorizationRequests)
		.innerJoin(
			oauthClients,
			eq(oauthClients.id, oauthAuthorizationRequests.clientId),
		)
		.where(
			and(
				eq(oauthAuthorizationRequests.id, input.requestId),
				eq(oauthAuthorizationRequests.status, "pending"),
				gt(oauthAuthorizationRequests.expiresAt, new Date()),
			),
		)
		.limit(1);
	if (!row) return null;
	let redirectHost = row.redirectUri;
	try {
		redirectHost =
			new URL(row.redirectUri).host ||
			new URL(row.redirectUri).protocol.replace(":", "");
	} catch {
		redirectHost = row.redirectUri;
	}
	return {
		requestId: row.id,
		clientName: row.clientName,
		clientUri: row.clientUri,
		scopes: (row.scope ?? "").split(" ").filter(Boolean),
		redirectHost,
		expiresAt: row.expiresAt.toISOString(),
	};
}

export async function approveAuthorization(input: {
	requestId: string;
}): Promise<{ redirectUrl: string }> {
	const user = await requireUser();
	const now = new Date();
	const [request] = await db()
		.select()
		.from(oauthAuthorizationRequests)
		.where(
			and(
				eq(oauthAuthorizationRequests.id, input.requestId),
				eq(oauthAuthorizationRequests.status, "pending"),
				gt(oauthAuthorizationRequests.expiresAt, now),
			),
		)
		.limit(1);
	if (!request) throw new Error("Authorization request not found");

	const scopes = parseOauthScopes(request.scope ?? undefined);
	if (!scopes) throw new Error("Invalid scope");

	const code = createAgentAuthorizationCode();
	await db().transaction(async (tx) => {
		const approved = await tx
			.update(oauthAuthorizationRequests)
			.set({ status: "approved", userId: user.id })
			.where(
				and(
					eq(oauthAuthorizationRequests.id, request.id),
					eq(oauthAuthorizationRequests.status, "pending"),
				),
			);
		if (getAffectedRows(approved) !== 1) {
			throw new Error("Authorization request not found");
		}
		await tx.insert(agentApiAuthorizationCodes).values({
			id: nanoId(),
			userId: user.id,
			codeHash: hashAgentSecret(code),
			codeChallenge: request.codeChallenge,
			redirectUri: request.redirectUri,
			scopes,
			clientId: request.clientId,
			expiresAt: new Date(now.getTime() + OAUTH_CODE_TTL_MS),
		});
	});

	const redirectUrl = buildOauthCallbackUrl(request.redirectUri, {
		state: request.state ?? undefined,
		code,
	});
	if (!redirectUrl) throw new Error("Invalid callback URL");
	return { redirectUrl };
}

export async function denyAuthorization(input: {
	requestId: string;
}): Promise<{ redirectUrl: string }> {
	await requireUser();
	const [request] = await db()
		.select()
		.from(oauthAuthorizationRequests)
		.where(
			and(
				eq(oauthAuthorizationRequests.id, input.requestId),
				eq(oauthAuthorizationRequests.status, "pending"),
			),
		)
		.limit(1);
	if (!request) throw new Error("Authorization request not found");

	await db()
		.update(oauthAuthorizationRequests)
		.set({ status: "denied" })
		.where(eq(oauthAuthorizationRequests.id, request.id));

	const redirectUrl = buildOauthCallbackUrl(request.redirectUri, {
		state: request.state ?? undefined,
		error: "access_denied",
	});
	if (!redirectUrl) throw new Error("Invalid callback URL");
	return { redirectUrl };
}

export async function listAgentConnections(): Promise<
	{
		id: string;
		clientName: string;
		scopes: string[];
		createdAt: string;
		lastUsedAt: string | null;
	}[]
> {
	const user = await requireUser();
	const now = new Date();
	const rows = await db()
		.select({
			id: agentApiKeys.id,
			scopes: agentApiKeys.scopes,
			createdAt: agentApiKeys.createdAt,
			lastUsedAt: agentApiKeys.lastUsedAt,
			clientName: oauthClients.name,
		})
		.from(agentApiKeys)
		.innerJoin(oauthClients, eq(oauthClients.id, agentApiKeys.oauthClientId))
		.where(
			and(
				eq(agentApiKeys.userId, user.id),
				isNotNull(agentApiKeys.oauthClientId),
				isNull(agentApiKeys.revokedAt),
				gt(agentApiKeys.expiresAt, now),
			),
		)
		.orderBy(desc(agentApiKeys.createdAt));

	return rows.map((row) => ({
		id: row.id,
		clientName: row.clientName,
		scopes: row.scopes,
		createdAt: row.createdAt.toISOString(),
		lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
	}));
}

export async function revokeAgentConnection(input: {
	id: string;
}): Promise<void> {
	const user = await requireUser();
	const now = new Date();
	await db()
		.update(agentApiKeys)
		.set({ revokedAt: now })
		.where(
			and(
				eq(agentApiKeys.id, input.id),
				eq(agentApiKeys.userId, user.id),
				isNotNull(agentApiKeys.oauthClientId),
				isNull(agentApiKeys.revokedAt),
			),
		);
	await db()
		.update(oauthRefreshTokens)
		.set({ revokedAt: now })
		.where(
			and(
				eq(oauthRefreshTokens.accessTokenId, input.id),
				eq(oauthRefreshTokens.userId, user.id),
				isNull(oauthRefreshTokens.revokedAt),
			),
		);
}
