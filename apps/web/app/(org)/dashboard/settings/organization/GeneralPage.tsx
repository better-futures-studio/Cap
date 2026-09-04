import DeleteOrg from "./components/DeleteOrg";
import { OrganizationDetailsCard } from "./components/OrganizationDetailsCard";
import { RecapSenderCard } from "./components/RecapSenderCard";

type RecapSenderSettings = {
	fromName: string | null;
	fromAddress: string | null;
	defaultFromName: string;
	defaultFromAddress: string;
	allowedDomain: string;
};

export function GeneralPage({
	orgId,
	recapSender,
}: {
	orgId: string;
	recapSender: RecapSenderSettings;
}) {
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-6 justify-center items-stretch xl:flex-row">
				<OrganizationDetailsCard />
				<RecapSenderCard orgId={orgId} initialSettings={recapSender} />
			</div>
			<DeleteOrg />
		</div>
	);
}
