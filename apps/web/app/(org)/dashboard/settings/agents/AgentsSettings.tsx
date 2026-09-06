"use client";

import { Button, Card, CardDescription, CardTitle } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { Bot, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { revokeAgentConnection } from "@/actions/oauth";
import { usePublicEnv } from "@/utils/public-env";
import { ConfirmationDialog } from "../../_components/ConfirmationDialog";
import { ApiKeyDisplay } from "../../developers/_components/ApiKeyDisplay";

export type AgentConnectionSummary = {
	id: string;
	clientName: string;
	scopes: string[];
	createdAt: string;
	lastUsedAt: string | null;
};

const formatDate = (iso: string) =>
	new Date(iso).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});

export const AgentsSettings = ({
	initialConnections,
	loadFailed = false,
}: {
	initialConnections: AgentConnectionSummary[];
	loadFailed?: boolean;
}) => {
	const router = useRouter();
	const { webUrl } = usePublicEnv();
	const mcpServerUrl = `${webUrl}/api/mcp`;
	const [connections, setConnections] = useState(initialConnections);
	const [revokeTarget, setRevokeTarget] =
		useState<AgentConnectionSummary | null>(null);

	const revokeMutation = useMutation({
		mutationFn: (id: string) => revokeAgentConnection({ id }),
		onSuccess: (_, id) => {
			setConnections((current) => current.filter((c) => c.id !== id));
			setRevokeTarget(null);
			toast.success("Agent disconnected");
			router.refresh();
		},
		onError: () => {
			toast.error("Failed to disconnect the agent");
		},
	});

	return (
		<>
			<Card className="flex flex-col gap-4">
				<div className="space-y-1">
					<CardTitle>Connect an agent</CardTitle>
					<CardDescription>
						Give an AI agent read access to your Cap meetings and recordings
						over MCP. Each agent asks you to approve access before it connects.
					</CardDescription>
				</div>
				<ApiKeyDisplay label="MCP server URL" value={mcpServerUrl} />
				<div className="grid gap-4 md:grid-cols-3">
					<div className="space-y-1">
						<p className="text-sm font-medium text-gray-12">Claude</p>
						<p className="text-sm text-gray-10">
							Settings → Connectors → Add custom connector → paste the URL.
						</p>
					</div>
					<div className="space-y-1">
						<p className="text-sm font-medium text-gray-12">ChatGPT</p>
						<p className="text-sm text-gray-10">
							Settings → Connectors → Create → MCP server URL.
						</p>
					</div>
					<div className="space-y-1">
						<p className="text-sm font-medium text-gray-12">Cursor / Codex</p>
						<p className="text-sm text-gray-10">
							Add an MCP server with that URL; sign-in opens in the browser.
						</p>
					</div>
				</div>
			</Card>

			<Card className="flex flex-col gap-4 mt-6">
				<div className="space-y-1">
					<CardTitle>Connected agents</CardTitle>
					<CardDescription>
						Agents that currently have access to your Cap account.
					</CardDescription>
				</div>
				{loadFailed && (
					<div className="px-4 py-3 text-sm rounded-xl border border-red-4 bg-red-2 text-red-11">
						Your connected agents could not be loaded. Refresh the page to try
						again. Existing connections are still active and can be revoked once
						the list loads.
					</div>
				)}
				{connections.length === 0 && !loadFailed && (
					<p className="text-sm text-gray-10">No agents connected yet.</p>
				)}
				{connections.length > 0 && (
					<div className="flex flex-col divide-y divide-gray-3 rounded-xl border border-gray-4">
						{connections.map((connection) => (
							<div
								className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between"
								key={connection.id}
							>
								<div className="min-w-0">
									<p className="text-sm font-medium truncate text-gray-12">
										{connection.clientName}
									</p>
									<div className="flex flex-wrap gap-1.5 mt-1.5">
										{connection.scopes.map((scope) => (
											<span
												className="px-2 py-0.5 text-xs rounded-full bg-gray-3 text-gray-11"
												key={scope}
											>
												{scope}
											</span>
										))}
									</div>
									<p className="mt-1.5 text-xs text-gray-10">
										Connected {formatDate(connection.createdAt)} ·{" "}
										{connection.lastUsedAt
											? `last used ${formatDate(connection.lastUsedAt)}`
											: "never used"}
									</p>
								</div>
								<Button
									className="shrink-0"
									icon={<Trash2 className="size-3.5" />}
									onClick={() => setRevokeTarget(connection)}
									size="xs"
									type="button"
									variant="destructive"
								>
									Revoke
								</Button>
							</div>
						))}
					</div>
				)}
			</Card>

			<ConfirmationDialog
				confirmLabel={revokeMutation.isPending ? "Disconnecting..." : "Revoke"}
				confirmVariant="destructive"
				description="The agent will lose access immediately."
				icon={<Bot className="size-4" />}
				loading={revokeMutation.isPending}
				onCancel={() => setRevokeTarget(null)}
				onConfirm={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
				open={revokeTarget !== null}
				title={`Revoke "${revokeTarget?.clientName}"?`}
			/>
		</>
	);
};
