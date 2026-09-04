"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	agentApiKeys,
	authApiKeys,
	organizationMembers,
	sessions,
	users,
} from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "./authorization";

export async function setMemberDisabled({
	orgId,
	userId,
	disabled,
}: {
	orgId: string;
	userId: string;
	disabled: boolean;
}): Promise<void> {
	const actorUser = await getCurrentUser();
	if (!actorUser) throw new Error("Unauthorized");

	const organizationId = Organisation.OrganisationId.make(orgId);
	const targetUserId = User.UserId.make(userId);

	await requireOrganizationSettingsManager(actorUser.id, organizationId);

	if (targetUserId === actorUser.id) {
		throw new Error("You cannot disable or enable yourself");
	}

	const [target] = await db()
		.select({
			id: users.id,
			systemKind: users.systemKind,
		})
		.from(users)
		.innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
		.where(
			and(
				eq(users.id, targetUserId),
				eq(organizationMembers.organizationId, organizationId),
			),
		)
		.limit(1);

	if (!target) throw new Error("Member not found");
	if (target.systemKind) {
		throw new Error("System users cannot be disabled");
	}

	await db().transaction(async (tx) => {
		if (disabled) {
			await tx
				.update(users)
				.set({
					disabledAt: new Date(),
					authSessionVersion: sql`${users.authSessionVersion} + 1`,
				})
				.where(eq(users.id, target.id));
			await tx.delete(sessions).where(eq(sessions.userId, target.id));
			await tx.delete(authApiKeys).where(eq(authApiKeys.userId, target.id));
			await tx
				.update(agentApiKeys)
				.set({ revokedAt: new Date() })
				.where(
					and(
						eq(agentApiKeys.userId, target.id),
						isNull(agentApiKeys.revokedAt),
					),
				);
			return;
		}

		await tx
			.update(users)
			.set({ disabledAt: null })
			.where(eq(users.id, target.id));
	});

	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard");
}
