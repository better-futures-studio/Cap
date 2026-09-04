import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getOrganizationRecapSender } from "@/actions/organization/recap-sender";
import { GeneralPage } from "./GeneralPage";

export const metadata: Metadata = {
	title: "Organization Settings — Cap",
};

export default async function OrganizationPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/auth/signin");
	if (!user.activeOrganizationId) redirect("/dashboard/caps");

	const recapSender = await getOrganizationRecapSender({
		orgId: user.activeOrganizationId,
	});

	return (
		<GeneralPage orgId={user.activeOrganizationId} recapSender={recapSender} />
	);
}
