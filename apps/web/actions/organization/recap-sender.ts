"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { isAllowedFromDomain } from "@cap/database/emails/config";
import { organizations } from "@cap/database/schema";
import { Organisation } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { DEFAULT_BOT_NAME, getRecallConfig } from "@/lib/recall/config";
import {
	defaultRecapFromAddress,
	parseRecapFromAddress,
	recapAllowedFromDomain,
} from "@/lib/recall/recap";
import { requireOrganizationSettingsManager } from "./authorization";

export type OrganizationRecapSender = {
	fromName: string | null;
	fromAddress: string | null;
	allowedDomain: string;
	defaultFromName: string;
	defaultFromAddress: string;
};

async function requireRecapSenderManager(orgId: Organisation.OrganisationId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	await requireOrganizationSettingsManager(user.id, orgId);
	const [organization] = await db()
		.select({
			id: organizations.id,
			settings: organizations.settings,
		})
		.from(organizations)
		.where(and(eq(organizations.id, orgId), isNull(organizations.tombstoneAt)))
		.limit(1);
	if (!organization) throw new Error("Organization not found");
	return organization;
}

function recapSenderResponse(
	settings: {
		recapFromName?: string;
		recapFromAddress?: string;
	} | null,
): OrganizationRecapSender {
	const allowedDomain = recapAllowedFromDomain();
	return {
		fromName: settings?.recapFromName?.trim() || null,
		fromAddress: settings?.recapFromAddress?.trim() || null,
		allowedDomain,
		defaultFromName: getRecallConfig()?.botName ?? DEFAULT_BOT_NAME,
		defaultFromAddress: defaultRecapFromAddress(allowedDomain),
	};
}

function asOrganizationId(orgId: string): Organisation.OrganisationId {
	return Organisation.OrganisationId.make(orgId);
}

export async function getOrganizationRecapSender({
	orgId,
}: {
	orgId: string;
}): Promise<OrganizationRecapSender> {
	const organization = await requireRecapSenderManager(asOrganizationId(orgId));
	return recapSenderResponse(organization.settings);
}

export async function setOrganizationRecapSender({
	orgId,
	fromName,
	fromAddress,
}: {
	orgId: string;
	fromName: string | null;
	fromAddress: string | null;
}): Promise<OrganizationRecapSender> {
	const organizationId = asOrganizationId(orgId);
	const organization = await requireRecapSenderManager(organizationId);
	const allowedDomain = recapAllowedFromDomain();
	const nextName = fromName?.trim() || undefined;
	const rawAddress = fromAddress?.trim() || undefined;
	let nextAddress: string | undefined;
	if (rawAddress) {
		const parsed = parseRecapFromAddress(rawAddress);
		if (!parsed) throw new Error("Enter a valid email address");
		if (!allowedDomain || !isAllowedFromDomain(parsed, allowedDomain)) {
			throw new Error(
				allowedDomain
					? `From address must use ${allowedDomain} or a subdomain of it`
					: "Sending domain is not configured",
			);
		}
		nextAddress = parsed;
	}

	const settings = { ...organization.settings };
	if (nextName) settings.recapFromName = nextName;
	else delete settings.recapFromName;
	if (nextAddress) settings.recapFromAddress = nextAddress;
	else delete settings.recapFromAddress;

	await db()
		.update(organizations)
		.set({ settings })
		.where(eq(organizations.id, organizationId));

	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard/settings/organization/preferences");
	revalidatePath("/dashboard/meetings");

	return recapSenderResponse({
		recapFromName: nextName,
		recapFromAddress: nextAddress,
	});
}
