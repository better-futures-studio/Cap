"use client";

import { Button, Switch } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	cancelMeetingBotAction,
	deleteMeeting,
	setCalendarSeriesRuleAction,
	toggleCalendarEventRecordingAction,
} from "@/actions/meetings";
import {
	groupByDay,
	meetingPlatformLabel,
	meetingUrlLabel,
} from "@/lib/recall/meetings-view";
import { ConfirmationDialog } from "../_components/ConfirmationDialog";
import {
	botStatusLabel,
	CANCELLABLE_STATUSES,
	type CalendarEvent,
	type CalendarSettings,
	formatTime,
	type MeetingBotRow,
	type UpcomingItem,
} from "./meetings-shared";

function UpcomingCalendarRow({
	orgId,
	calendarRowId,
	event,
}: {
	orgId: Organisation.OrganisationId;
	calendarRowId: string;
	event: CalendarEvent;
}) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const url = event.meetingUrl ?? "";
	const recordId = useId();

	const toggle = (record: boolean) => {
		startTransition(async () => {
			try {
				await toggleCalendarEventRecordingAction({
					orgId,
					calendarRowId,
					eventId: event.id,
					record,
				});
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to update the event",
				);
			}
		});
	};

	const setSeriesRule = (record: boolean) => {
		startTransition(async () => {
			try {
				await setCalendarSeriesRuleAction({
					orgId,
					calendarRowId,
					eventId: event.id,
					record,
				});
				toast.success(
					record
						? "Recording every occurrence"
						: "Stopped recording the series",
				);
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to update the series",
				);
			}
		});
	};

	return (
		<div className="flex items-center gap-3 py-2">
			<span className="w-20 shrink-0 text-xs text-gray-10">
				{formatTime(new Date(event.startTime))}
			</span>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm text-gray-12">
					{event.title ?? (url ? meetingUrlLabel(url) : "Untitled meeting")}
				</p>
				<p className="text-xs text-gray-10">{meetingPlatformLabel(url)}</p>
			</div>
			{event.seriesKey && (
				<div className="flex shrink-0 items-center gap-1.5">
					{event.seriesRule !== null && (
						<span className="text-xs text-gray-9">
							Series: {event.seriesRule ? "on" : "off"}
						</span>
					)}
					<button
						type="button"
						className="text-xs text-gray-10 hover:underline disabled:opacity-50"
						disabled={isPending}
						onClick={() => setSeriesRule(!event.seriesRule)}
					>
						All in series
					</button>
				</div>
			)}
			<label
				htmlFor={recordId}
				className="flex shrink-0 items-center gap-2 text-xs text-gray-10"
			>
				<Switch
					id={recordId}
					checked={event.recording}
					disabled={isPending}
					onCheckedChange={toggle}
				/>
				Record
			</label>
		</div>
	);
}

function UpcomingBotRow({
	orgId,
	userId,
	bot,
}: {
	orgId: Organisation.OrganisationId;
	userId: string;
	bot: MeetingBotRow;
}) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	const cancel = () => {
		startTransition(async () => {
			try {
				await cancelMeetingBotAction({ orgId, id: bot.id });
				toast.success("Meeting bot cancelled");
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to cancel bot",
				);
			}
		});
	};

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

	return (
		<div className="flex items-center gap-3 py-2">
			<span className="w-20 shrink-0 text-xs text-gray-10">
				{formatTime(new Date(bot.joinAt))}
			</span>
			<div className="min-w-0 flex-1">
				{bot.status === "in_call_not_recording" ||
				bot.status === "in_call_recording" ? (
					<a
						href={`/dashboard/meetings/${bot.id}`}
						className="block truncate text-sm text-gray-12 hover:underline"
					>
						{bot.title ?? meetingUrlLabel(bot.meetingUrl)}
					</a>
				) : (
					<p className="truncate text-sm text-gray-12">
						{bot.title ?? meetingUrlLabel(bot.meetingUrl)}
					</p>
				)}
				<p className="text-xs text-gray-10">
					{meetingPlatformLabel(bot.meetingUrl, bot.source)}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<span className="text-xs text-gray-10">
					{botStatusLabel(bot.status)}
				</span>
				{CANCELLABLE_STATUSES.has(bot.status) && (
					<button
						type="button"
						className="text-xs text-gray-10 hover:underline disabled:opacity-50"
						disabled={isPending}
						onClick={cancel}
					>
						Cancel
					</button>
				)}
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

export function UpcomingTab({
	orgId,
	userId,
	items,
	settings,
}: {
	orgId: Organisation.OrganisationId;
	userId: string;
	items: UpcomingItem[];
	settings: CalendarSettings;
}) {
	if (items.length === 0) {
		return (
			<div className="flex flex-col items-center gap-2 py-8 text-center">
				<p className="text-sm text-gray-10">
					No upcoming meetings with a video link in the next 14 days.
				</p>
				{settings.calendarConfigured && !settings.calendar && (
					<Button href="/api/integrations/recall-calendar/connect" size="sm">
						Connect Google Calendar
					</Button>
				)}
			</div>
		);
	}

	const groups = groupByDay(items, new Date(), (item) => item.time);

	return (
		<div className="flex flex-col gap-3">
			{groups.map((group) => (
				<div key={group.label}>
					<p className="text-xs font-medium text-gray-10">{group.label}</p>
					<div className="divide-y divide-gray-3">
						{group.items.map((item) =>
							item.kind === "calendar" ? (
								<UpcomingCalendarRow
									key={item.key}
									orgId={orgId}
									calendarRowId={settings.calendar?.id ?? ""}
									event={item.event}
								/>
							) : (
								<UpcomingBotRow
									key={item.key}
									orgId={orgId}
									userId={userId}
									bot={item.bot}
								/>
							),
						)}
					</div>
				</div>
			))}
		</div>
	);
}
