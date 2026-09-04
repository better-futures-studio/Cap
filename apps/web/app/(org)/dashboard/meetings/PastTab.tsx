"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { deleteMeeting } from "@/actions/meetings";
import {
	meetingPlatformLabel,
	meetingUrlLabel,
} from "@/lib/recall/meetings-view";
import { ConfirmationDialog } from "../_components/ConfirmationDialog";
import { formatPastDate, type MeetingBotRow } from "./meetings-shared";

function PastRow({ bot, userId }: { bot: MeetingBotRow; userId: string }) {
	const router = useRouter();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	const remove = async () => {
		setIsDeleting(true);
		try {
			await deleteMeeting({ meetingBotId: bot.id });
			toast.success("Meeting deleted");
			setConfirmOpen(false);
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to delete meeting",
			);
		} finally {
			setIsDeleting(false);
		}
	};

	const platform = meetingPlatformLabel(bot.meetingUrl, bot.source);
	const title = bot.title ?? meetingUrlLabel(bot.meetingUrl);

	let result: React.ReactNode;
	if (bot.status === "complete" && bot.videoId) {
		result = (
			<a
				href={`/s/${bot.videoId}`}
				className="text-xs font-medium text-blue-600 hover:underline"
			>
				View recording
			</a>
		);
	} else if (
		bot.status === "importing" ||
		bot.status === "transcribing" ||
		bot.status === "done" ||
		bot.status === "call_ended"
	) {
		result = (
			<span className="text-xs text-gray-10">Processing recording…</span>
		);
	} else if (bot.status === "fatal" || bot.status === "failed") {
		result = (
			<span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md bg-red-500/10 text-red-600">
				Failed
			</span>
		);
	} else {
		result = (
			<span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md bg-gray-3 text-gray-9">
				Cancelled
			</span>
		);
	}

	return (
		<div className="flex items-center gap-3 py-2">
			<span className="w-32 shrink-0 text-xs text-gray-10">
				{formatPastDate(new Date(bot.joinAt))}
			</span>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm text-gray-12">{title}</p>
				<p className="text-xs text-gray-10">{platform}</p>
				{(bot.status === "fatal" || bot.status === "failed") &&
					bot.errorMessage && (
						<p className="text-xs text-red-600">{bot.errorMessage}</p>
					)}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{result}
				{bot.ownerId === userId && (
					<button
						type="button"
						className="text-xs text-red-600 hover:underline disabled:opacity-50"
						onClick={() => setConfirmOpen(true)}
					>
						Delete
					</button>
				)}
			</div>
			<ConfirmationDialog
				open={confirmOpen}
				title="Delete meeting"
				description="This permanently deletes the recording, transcript, and summary for everyone it was shared with. This cannot be undone."
				confirmLabel="Delete"
				confirmVariant="destructive"
				loading={isDeleting}
				onConfirm={remove}
				onCancel={() => setConfirmOpen(false)}
			/>
		</div>
	);
}

export function PastTab({
	bots,
	userId,
}: {
	bots: MeetingBotRow[];
	userId: string;
}) {
	if (bots.length === 0) {
		return <p className="text-sm text-gray-10">No recordings yet.</p>;
	}

	return (
		<div className="divide-y divide-gray-3">
			{bots.map((bot) => (
				<PastRow key={bot.id} bot={bot} userId={userId} />
			))}
		</div>
	);
}
