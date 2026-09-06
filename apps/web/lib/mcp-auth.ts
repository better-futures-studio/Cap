import { createHash } from "node:crypto";
import { db } from "@cap/database";
import { agentApiKeys, users } from "@cap/database/schema";
import { shouldRefreshAgentLastUsedAt } from "@cap/web-backend";
import type { Agent, Organisation, User } from "@cap/web-domain";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { parseOauthScopes } from "@/lib/agent-auth";

const agentLastUsedRefreshMs = 5 * 60 * 1000;

export type McpPrincipal = {
	id: User.UserId;
	email: string;
	activeOrganizationId: Organisation.OrganisationId;
	scopes: ReadonlySet<Agent.AgentScope>;
	tokenId: string;
	expiresAt: Date;
};

export function parseBearerToken(authorization: string | null | undefined) {
	if (!authorization) return null;
	const [scheme, token, extra] = authorization.trim().split(/\s+/);
	if (scheme?.toLowerCase() !== "bearer" || !token || extra) return null;
	return token;
}

export function hashBearerToken(token: string) {
	return createHash("sha256").update(token).digest("hex");
}

export async function authenticateMcpBearer(
	authorization: string | null | undefined,
): Promise<McpPrincipal | null> {
	const token = parseBearerToken(authorization);
	if (!token) return null;
	if (!/^cap_cli_[A-Za-z0-9_-]{43}$/.test(token)) return null;

	const [row] = await db()
		.select({
			tokenId: agentApiKeys.id,
			scopes: agentApiKeys.scopes,
			expiresAt: agentApiKeys.expiresAt,
			revokedAt: agentApiKeys.revokedAt,
			lastUsedAt: agentApiKeys.lastUsedAt,
			id: users.id,
			email: users.email,
			activeOrganizationId: users.activeOrganizationId,
		})
		.from(agentApiKeys)
		.innerJoin(users, eq(agentApiKeys.userId, users.id))
		.where(eq(agentApiKeys.tokenHash, hashBearerToken(token)))
		.limit(1);

	if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
		return null;
	}
	const parsed = parseOauthScopes(
		Array.isArray(row.scopes) ? row.scopes.join(" ") : "",
	);
	if (!parsed || parsed.length === 0) return null;

	const now = new Date();
	if (shouldRefreshAgentLastUsedAt(row.lastUsedAt, now)) {
		await db()
			.update(agentApiKeys)
			.set({ lastUsedAt: now })
			.where(
				and(
					eq(agentApiKeys.id, row.tokenId),
					or(
						isNull(agentApiKeys.lastUsedAt),
						lte(
							agentApiKeys.lastUsedAt,
							new Date(now.getTime() - agentLastUsedRefreshMs),
						),
					),
				),
			);
	}

	return {
		id: row.id,
		email: row.email,
		activeOrganizationId: row.activeOrganizationId,
		scopes: new Set(parsed),
		tokenId: row.tokenId,
		expiresAt: row.expiresAt,
	};
}

export function principalHasScope(
	principal: McpPrincipal,
	scope: Agent.AgentScope,
) {
	return principal.scopes.has(scope);
}
