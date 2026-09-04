import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { ImageUpload, Organisation, User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./recall/config";

export type SystemUserKind = "notetaker" | "external";

function stripTrailingSlash(url: string): string {
	return url.replace(/\/$/, "");
}

function systemUserEmail(kind: SystemUserKind, orgId: string): string {
	return `${kind}+${orgId}@system.invalid`;
}

function notetakerImage(orgId: string): ImageUpload.ImageUrlOrKey {
	return ImageUpload.ImageUrl.make(
		`${stripTrailingSlash(serverEnv().WEB_URL)}/api/meeting-bot/logo?orgId=${orgId}`,
	);
}

export async function getOrCreateSystemUser({
	orgId,
	kind,
}: {
	orgId: string;
	kind: SystemUserKind;
}): Promise<typeof users.$inferSelect> {
	const email = systemUserEmail(kind, orgId);
	const [existing] = await db()
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	if (existing) return existing;

	const organizationId = Organisation.OrganisationId.make(orgId);
	await db()
		.insert(users)
		.values({
			id: User.UserId.make(nanoId()),
			name:
				kind === "notetaker"
					? (getRecallConfig()?.botName ?? DEFAULT_BOT_NAME)
					: "External participant",
			email,
			emailVerified: null,
			image: kind === "notetaker" ? notetakerImage(orgId) : null,
			activeOrganizationId: organizationId,
			defaultOrgId: organizationId,
			systemKind: kind,
			systemOrganizationId: organizationId,
		})
		.onDuplicateKeyUpdate({ set: { email } });

	const [created] = await db()
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	if (!created) {
		throw new Error(`Failed to create ${kind} system user`);
	}
	return created;
}
