"use client";

import { Button, Logo } from "@cap/ui";
import { signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	approveAuthorization,
	denyAuthorization,
	getPendingAuthorization,
	type PendingAuthorization,
} from "@/actions/oauth";

const scopeLabels: Record<string, string> = {
	"meetings:read":
		"Read your meetings, transcripts, summaries, and action items",
	"caps:read": "Read your recordings",
};

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<main className="flex justify-center items-center px-6 min-h-screen bg-gray-2">
			<section className="p-8 w-full max-w-md rounded-2xl border shadow-sm border-gray-4 bg-gray-1">
				<Logo className="mb-8 w-auto h-8" />
				{children}
			</section>
		</main>
	);
}

export function OAuthConsent({
	initialPendingAuthorization,
	email,
	currentUrl,
}: {
	initialPendingAuthorization: PendingAuthorization;
	email: string;
	currentUrl: string;
}) {
	const requestId = initialPendingAuthorization.requestId;
	const [pendingAction, setPendingAction] = useState<"approve" | "deny" | null>(
		null,
	);

	const [pendingAuthorization, setPendingAuthorization] =
		useState<PendingAuthorization | null>(initialPendingAuthorization);
	useEffect(() => {
		let cancelled = false;
		getPendingAuthorization({ requestId })
			.then((pending) => {
				if (!cancelled) setPendingAuthorization(pending);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [requestId]);

	if (!pendingAuthorization) {
		return (
			<Shell>
				<h1 className="text-xl font-semibold text-gray-12">
					This request expired
				</h1>
				<p className="mt-3 text-sm leading-6 text-gray-10">
					Return to the app and start connecting again.
				</p>
			</Shell>
		);
	}

	const { clientName, scopes, redirectHost } = pendingAuthorization;

	const respond = async (action: "approve" | "deny") => {
		setPendingAction(action);
		try {
			const { redirectUrl } =
				action === "approve"
					? await approveAuthorization({ requestId })
					: await denyAuthorization({ requestId });
			window.location.assign(redirectUrl);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: `Failed to ${action} the request`,
			);
			setPendingAction(null);
		}
	};

	return (
		<Shell>
			<h1 className="text-xl text-gray-12">
				<strong className="font-semibold">{clientName}</strong> wants to access
				your Cap account
			</h1>
			<p className="mt-2 text-sm text-gray-10">Redirects to {redirectHost}</p>
			<ul className="mt-5 space-y-3 text-sm text-gray-11">
				{scopes.map((scope) => (
					<li className="px-4 py-3 rounded-lg bg-gray-2" key={scope}>
						{scopeLabels[scope] ?? scope}
					</li>
				))}
			</ul>
			<div className="mt-8 space-y-3">
				<Button
					className="w-full"
					disabled={pendingAction !== null}
					onClick={() => respond("approve")}
					size="sm"
					spinner={pendingAction === "approve"}
					variant="dark"
				>
					{pendingAction === "approve" ? "Connecting..." : "Approve"}
				</Button>
				<Button
					className="w-full"
					disabled={pendingAction !== null}
					onClick={() => respond("deny")}
					size="sm"
					spinner={pendingAction === "deny"}
					variant="gray"
				>
					{pendingAction === "deny" ? "Denying..." : "Deny"}
				</Button>
			</div>
			<p className="mt-6 text-xs leading-5 text-gray-9">
				Signed in as {email}.{" "}
				<button
					className="underline hover:text-gray-11"
					onClick={() =>
						signOut({
							callbackUrl: `/login?next=${encodeURIComponent(currentUrl)}`,
						})
					}
					type="button"
				>
					Not you? Sign out
				</button>
			</p>
		</Shell>
	);
}
