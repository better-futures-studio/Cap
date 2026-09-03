"use client";

import type { MeetingBotStatus } from "@cap/database/schema";
import {
	Button,
	Input,
	Switch,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@cap/ui";
import { classNames } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	cancelMeetingBotAction,
	disconnectCalendarAction,
	type getMeetingCalendarSettings,
	type listMeetingBots,
	scheduleMeetingBot,
	setCalendarAutoRecordAction,
	toggleCalendarEventRecordingAction,
} from "@/actions/meetings";

type MeetingBotRow = Awaited<ReturnType<typeof listMeetingBots>>[number];
type CalendarSettings = Awaited<ReturnType<typeof getMeetingCalendarSettings>>;

const TERMINAL_STATUSES = new Set<MeetingBotStatus>([
	"complete",
	"fatal",
	"failed",
	"cancelled",
	"opted_out",
]);

const CANCELLABLE_STATUSES = new Set<MeetingBotStatus>([
	"scheduling",
	"scheduled",
]);

const calendarResultMessages: Record<
	string,
	{ type: "success" | "error"; message: string }
> = {
	connected: { type: "success", message: "Google Calendar connected" },
	cancelled: {
		type: "error",
		message: "Calendar connection was cancelled",
	},
	invalid: {
		type: "error",
		message: "Calendar connection expired or was invalid",
	},
	failed: { type: "error", message: "Calendar connection failed" },
	"not-configured": {
		type: "error",
		message: "Calendar recording is not configured on this deployment",
	},
};

function statusBadgeClass(status: MeetingBotStatus) {
	if (status === "complete") return "bg-green-500/10 text-green-600";
	if (status === "fatal" || status === "failed")
		return "bg-red-500/10 text-red-600";
	if (status === "cancelled" || status === "opted_out")
		return "bg-gray-3 text-gray-9";
	return "bg-blue-500/10 text-blue-600";
}

function formatEventTime(date: Date) {
	const day = date.toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
	});
	const time = date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
	return `${day} · ${time}`;
}

function RecordingCell({ bot }: { bot: MeetingBotRow }) {
	if (bot.videoReady && bot.videoId) {
		return (
			<a
				href={`/s/${bot.videoId}`}
				target="_blank"
				rel="noopener noreferrer"
				className="text-xs font-medium text-blue-600 hover:underline"
			>
				View recording
			</a>
		);
	}
	if (bot.videoId) {
		return <span className="text-xs text-gray-10">Processing…</span>;
	}
	return <span className="text-xs text-gray-10">—</span>;
}

function SendBotForm({
	orgId,
	onScheduled,
}: {
	orgId: Organisation.OrganisationId;
	onScheduled: () => void;
}) {
	const [meetingUrl, setMeetingUrl] = useState("");
	const [isPending, startTransition] = useTransition();
	const meetingUrlId = useId();

	const submit = () => {
		if (!meetingUrl.trim()) {
			toast.error("Enter a meeting URL");
			return;
		}
		startTransition(async () => {
			try {
				await scheduleMeetingBot({
					orgId,
					meetingUrl: meetingUrl.trim(),
				});
				toast.success("Bot is on its way");
				setMeetingUrl("");
				onScheduled();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to schedule bot",
				);
			}
		});
	};

	return (
		<div className="rounded-xl border border-gray-3 overflow-hidden">
			<div className="px-4 py-3">
				<p className="text-sm font-semibold text-gray-12">
					Send a bot to a meeting{" "}
					<span className="text-xs font-normal text-gray-10">
						— joins right away as a visible participant and announces the
						recording in chat
					</span>
				</p>
			</div>
			<div className="border-t border-gray-3 px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-end">
				<div className="flex-1 flex flex-col gap-1.5">
					<label htmlFor={meetingUrlId} className="text-xs text-gray-10">
						Meeting URL
					</label>
					<Input
						id={meetingUrlId}
						placeholder="Zoom, Google Meet, Microsoft Teams, or Webex link"
						value={meetingUrl}
						onChange={(event) => setMeetingUrl(event.target.value)}
						disabled={isPending}
					/>
				</div>
				<Button
					type="button"
					size="sm"
					disabled={isPending}
					spinner={isPending}
					onClick={submit}
				>
					Send bot
				</Button>
			</div>
		</div>
	);
}

function RecentMeetings({
	orgId,
	bots,
}: {
	orgId: Organisation.OrganisationId;
	bots: MeetingBotRow[];
}) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();

	const cancel = (id: string) => {
		startTransition(async () => {
			try {
				await cancelMeetingBotAction({ orgId, id });
				toast.success("Meeting bot cancelled");
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to cancel bot",
				);
			}
		});
	};

	return (
		<div className="rounded-xl border border-gray-3 overflow-hidden">
			<div className="px-4 py-3">
				<p className="text-sm font-semibold text-gray-12">Recent meetings</p>
			</div>
			<div className="border-t border-gray-3">
				{bots.length === 0 ? (
					<p className="px-4 py-3 text-xs text-gray-10">
						No meetings recorded yet.
					</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Meeting</TableHead>
								<TableHead>When</TableHead>
								<TableHead>Source</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Recording</TableHead>
								<TableHead className="w-20">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{bots.map((bot) => (
								<TableRow key={bot.id}>
									<TableCell className="max-w-[220px] py-2">
										<p className="truncate text-sm text-gray-12">
											{bot.title ?? bot.meetingUrl}
										</p>
										{bot.title && (
											<p className="truncate text-xs text-gray-10">
												{bot.meetingUrl}
											</p>
										)}
									</TableCell>
									<TableCell className="py-2 text-sm">
										{new Date(bot.joinAt).toLocaleString()}
									</TableCell>
									<TableCell className="py-2 text-sm capitalize">
										{bot.source}
									</TableCell>
									<TableCell className="py-2">
										<span
											className={classNames(
												"inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md",
												statusBadgeClass(bot.status),
											)}
										>
											{bot.status.replace(/_/g, " ")}
										</span>
										{(bot.status === "fatal" || bot.status === "failed") &&
											bot.errorMessage && (
												<p className="mt-1 text-xs text-red-600">
													{bot.errorMessage}
												</p>
											)}
									</TableCell>
									<TableCell className="py-2">
										<RecordingCell bot={bot} />
									</TableCell>
									<TableCell className="py-2">
										{CANCELLABLE_STATUSES.has(bot.status) && (
											<Button
												type="button"
												size="xs"
												variant="destructive"
												disabled={isPending}
												onClick={() => cancel(bot.id)}
											>
												Cancel
											</Button>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</div>
		</div>
	);
}

function CalendarSection({
	orgId,
	settings,
}: {
	orgId: Organisation.OrganisationId;
	settings: CalendarSettings;
}) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();

	if (!settings.calendarConfigured) {
		return (
			<div className="rounded-xl border border-gray-3 px-4 py-3">
				<p className="text-xs text-gray-10">
					Calendar recording isn't configured on this deployment.
				</p>
			</div>
		);
	}

	if (!settings.calendar) {
		return (
			<div className="rounded-xl border border-gray-3 overflow-hidden">
				<div className="px-4 py-3">
					<p className="text-sm font-semibold text-gray-12">Calendar</p>
				</div>
				<div className="border-t border-gray-3 px-4 py-3 flex items-center justify-between gap-3">
					<p className="text-xs text-gray-10">
						Connect Google Calendar to opt in to recording meetings, either per
						event or automatically.
					</p>
					<Button href="/api/integrations/recall-calendar/connect" size="xs">
						Connect Google Calendar
					</Button>
				</div>
			</div>
		);
	}

	const { calendar } = settings;

	const setAutoRecord = (autoRecord: boolean) => {
		startTransition(async () => {
			try {
				await setCalendarAutoRecordAction({
					orgId,
					calendarRowId: calendar.id,
					autoRecord,
				});
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to update auto-record",
				);
			}
		});
	};

	const toggleEvent = (eventId: string, record: boolean) => {
		startTransition(async () => {
			try {
				await toggleCalendarEventRecordingAction({
					orgId,
					calendarRowId: calendar.id,
					eventId,
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

	const disconnect = () => {
		if (
			!window.confirm(
				"Disconnect this Google Calendar? Scheduled recordings for its events will be cancelled.",
			)
		) {
			return;
		}
		startTransition(async () => {
			try {
				await disconnectCalendarAction({
					orgId,
					calendarRowId: calendar.id,
				});
				toast.success("Calendar disconnected");
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to disconnect",
				);
			}
		});
	};

	const isConnected = calendar.status === "connected";

	return (
		<div className="rounded-xl border border-gray-3 overflow-hidden">
			<div className="flex items-center gap-3 px-4 py-3">
				<div className="flex-1 min-w-0 flex items-center gap-2">
					<p className="text-sm font-semibold text-gray-12">Calendar</p>
					<span className="truncate text-xs text-gray-10">
						{calendar.platformEmail ?? "Google Calendar"}
					</span>
					<span
						className={classNames(
							"inline-flex items-center px-1.5 py-0.5 text-xs font-medium rounded-md shrink-0",
							isConnected
								? "bg-green-500/10 text-green-600"
								: "bg-gray-3 text-gray-10",
						)}
					>
						{calendar.status}
					</span>
				</div>
				<Button
					type="button"
					size="xs"
					variant="destructive"
					disabled={isPending}
					onClick={disconnect}
				>
					Disconnect
				</Button>
			</div>
			<div className="border-t border-gray-3 px-4 py-3 flex flex-col gap-3">
				<div className="flex items-center justify-between gap-3">
					<p className="text-xs text-gray-10">
						Automatically record every meeting with a video link (off by
						default)
					</p>
					<Switch
						checked={calendar.autoRecord}
						disabled={isPending}
						onCheckedChange={setAutoRecord}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<p className="text-xs text-gray-10">
						Upcoming meetings (next 14 days)
					</p>
					{settings.upcoming.length === 0 ? (
						<p className="text-xs text-gray-10">
							No upcoming meetings with a video link.
						</p>
					) : (
						<div className="rounded-lg bg-gray-2 divide-y divide-gray-3 max-h-80 overflow-y-auto">
							{settings.upcoming.map((event) => (
								<div
									key={event.id}
									className="flex items-center gap-3 py-1.5 px-3"
								>
									<p className="flex-1 min-w-0 truncate text-sm text-gray-12">
										{event.title ?? "Untitled meeting"}
									</p>
									<p className="shrink-0 text-xs text-gray-10">
										{formatEventTime(new Date(event.startTime))}
									</p>
									<Switch
										checked={event.recording}
										disabled={isPending}
										onCheckedChange={(checked) =>
											toggleEvent(event.id, checked)
										}
									/>
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

export function MeetingsPage({
	orgId,
	initialBots,
	calendarSettings,
	result,
}: {
	orgId: Organisation.OrganisationId;
	initialBots: MeetingBotRow[];
	calendarSettings: CalendarSettings;
	result?: string;
}) {
	const router = useRouter();
	const [bots, setBots] = useState(initialBots);

	useEffect(() => {
		setBots(initialBots);
	}, [initialBots]);

	useEffect(() => {
		if (!result) return;
		const notification = calendarResultMessages[result];
		if (notification?.type === "success") {
			toast.success(notification.message);
		} else if (notification) {
			toast.error(notification.message);
		}
		router.replace("/dashboard/meetings");
	}, [result, router]);

	useEffect(() => {
		const hasPending = bots.some((bot) => !TERMINAL_STATUSES.has(bot.status));
		if (!hasPending) return;
		const interval = setInterval(() => router.refresh(), 15000);
		return () => clearInterval(interval);
	}, [bots, router]);

	return (
		<div className="flex flex-col gap-3">
			{calendarSettings.configured ? (
				<SendBotForm orgId={orgId} onScheduled={() => router.refresh()} />
			) : (
				<div className="rounded-xl border border-gray-3 px-4 py-3">
					<p className="text-xs text-gray-10">
						Meeting bots aren't configured on this deployment.
					</p>
				</div>
			)}
			<RecentMeetings orgId={orgId} bots={bots} />
			<CalendarSection orgId={orgId} settings={calendarSettings} />
		</div>
	);
}
