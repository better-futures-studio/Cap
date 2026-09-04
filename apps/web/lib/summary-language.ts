import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import {
	type AiGenerationLanguage,
	type Organisation,
	parseSummaryLanguage,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";

export async function loadOrganizationSummaryLanguage(
	orgId: Organisation.OrganisationId,
): Promise<AiGenerationLanguage> {
	const [org] = await db()
		.select({ settings: organizations.settings })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.limit(1);
	return parseSummaryLanguage(org?.settings?.summaryLanguage);
}
