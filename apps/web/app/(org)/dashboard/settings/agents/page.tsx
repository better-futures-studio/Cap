import type { Metadata } from "next";
import { listAgentConnections } from "@/actions/oauth";
import { AgentsSettings } from "./AgentsSettings";

export const metadata: Metadata = {
	title: "AI agents — Cap",
};

export default async function AgentsSettingsPage() {
	// A failed connections query must not 500 the whole settings page, but it also must not
	// render as an empty list, which would hide connections the user may still need to revoke.
	const connections = await listAgentConnections().catch(() => null);
	return (
		<AgentsSettings
			initialConnections={connections ?? []}
			loadFailed={connections === null}
		/>
	);
}
