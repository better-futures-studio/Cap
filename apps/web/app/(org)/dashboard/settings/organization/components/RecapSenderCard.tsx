"use client";

import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
} from "@cap/ui";
import { useId, useState } from "react";
import { toast } from "sonner";
import { setOrganizationRecapSender } from "@/actions/organization/recap-sender";

type RecapSenderSettings = {
	fromName: string | null;
	fromAddress: string | null;
	defaultFromName: string;
	defaultFromAddress: string;
	allowedDomain: string;
};

export function RecapSenderCard({
	orgId,
	initialSettings,
}: {
	orgId: string;
	initialSettings: RecapSenderSettings;
}) {
	const [fromName, setFromName] = useState(initialSettings.fromName ?? "");
	const [fromAddress, setFromAddress] = useState(
		initialSettings.fromAddress ?? "",
	);
	const [saveLoading, setSaveLoading] = useState(false);
	const nameInputId = useId();
	const addressInputId = useId();

	const effectiveName = fromName || initialSettings.defaultFromName;
	const effectiveAddress = fromAddress || initialSettings.defaultFromAddress;

	const handleSave = async () => {
		try {
			setSaveLoading(true);
			await setOrganizationRecapSender({ orgId, fromName, fromAddress });
			toast.success("Recap sender updated");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "An error occurred while updating the recap sender",
			);
		} finally {
			setSaveLoading(false);
		}
	};

	return (
		<Card className="flex flex-col flex-1 gap-6 w-full min-h-fit">
			<CardHeader>
				<CardTitle>Meeting recap emails</CardTitle>
				<CardDescription>
					Choose the name and address meeting recap emails are sent from.
				</CardDescription>
			</CardHeader>
			<div className="flex flex-col gap-4">
				<div className="space-y-1">
					<Label htmlFor={nameInputId}>Sender name</Label>
					<Input
						type="text"
						className="bg-gray-2"
						value={fromName}
						id={nameInputId}
						name="recapSenderName"
						placeholder={initialSettings.defaultFromName}
						onChange={(e) => setFromName(e.target.value)}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor={addressInputId}>Sender address</Label>
					<Input
						type="text"
						className="bg-gray-2"
						value={fromAddress}
						id={addressInputId}
						name="recapSenderAddress"
						placeholder={initialSettings.defaultFromAddress}
						onChange={(e) => setFromAddress(e.target.value)}
					/>
				</div>
				<p className="text-sm text-gray-10">
					Must be on {initialSettings.allowedDomain} (your verified sending
					domain). Leave blank to use the defaults.
				</p>
				<p className="text-sm text-gray-10">
					Preview: {effectiveName} &lt;{effectiveAddress}&gt;
				</p>
				<Button
					type="submit"
					size="sm"
					className="self-start min-w-fit"
					variant="dark"
					spinner={saveLoading}
					onClick={handleSave}
					disabled={saveLoading}
				>
					{saveLoading ? null : "Save"}
				</Button>
			</div>
		</Card>
	);
}
