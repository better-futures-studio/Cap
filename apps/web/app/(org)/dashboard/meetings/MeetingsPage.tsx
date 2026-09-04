"use client";

import type { MeetingBotStatus, MeetingRecapMode } from "@cap/database/schema";
import { Button, Input, Select, Switch } from "@cap/ui";
import { classNames } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	addMeetingVocabulary,
	cancelMeetingBotAction,
	disconnectCalendarAction,
	type getMeetingCalendarSettings,
	type getSlackHuddleStatus,
	type listMeetingBots,
	type listMeetingVocabulary,
	removeMeetingVocabulary,
	scheduleMeetingBot,
	setCalendarAutoRecordAction,
	setCalendarSeriesRuleAction,
	setMeetingPreferences,
	toggleCalendarEventRecordingAction,
} from "@/actions/meetings";
import {
	groupByDay,
	meetingPlatformLabel,
	meetingUrlLabel,
} from "@/lib/recall/meetings-view";

type MeetingBotRow = Awaited<
	ReturnType<typeof listMeetingBots>
>["upcoming"][number];
type CalendarSettings = Awaited<ReturnType<typeof getMeetingCalendarSettings>>;
type CalendarEvent = CalendarSettings["upcoming"][number];
type SlackHuddleStatus = Awaited<ReturnType<typeof getSlackHuddleStatus>>;
type VocabularyTerm = Awaited<ReturnType<typeof listMeetingVocabulary>>[number];

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

function botStatusLabel(status: MeetingBotStatus): string {
	if (status === "scheduling" || status === "scheduled") return "Bot scheduled";
	if (status === "joining_call" || status === "in_waiting_room")
		return "Joining…";
	return "Recording now";
}

function formatTime(date: Date): string {
	return date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatPastDate(date: Date): string {
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function SendBotBar({
	orgId,
	botName,
	onScheduled,
}: {
	orgId: Organisation.OrganisationId;
	botName: string;
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
				await scheduleMeetingBot({ orgId, meetingUrl: meetingUrl.trim() });
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
		<div className="flex flex-col gap-1.5 rounded-lg border border-gray-3 p-3">
			<div className="flex gap-2">
				<Input
					id={meetingUrlId}
					placeholder="Paste a Zoom, Google Meet, Microsoft Teams, or Webex link to send the notetaker now"
					value={meetingUrl}
					onChange={(event) => setMeetingUrl(event.target.value)}
					disabled={isPending}
					onKeyDown={(event) => {
						if (event.key === "Enter") submit();
					}}
					className="flex-1"
				/>
				<Button
					type="button"
					disabled={isPending}
					spinner={isPending}
					onClick={submit}
				>
					Send bot
				</Button>
			</div>
			<p className="text-xs text-gray-10">
				The bot joins as a visible participant named {botName} and announces the
				recording in chat.
			</p>
		</div>
	);
}

function CalendarStrip({
	orgId,
	settings,
}: {
	orgId: Organisation.OrganisationId;
	settings: CalendarSettings;
}) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const autoRecordId = useId();

	if (!settings.calendarConfigured) return null;

	if (!settings.calendar) {
		return (
			<div className="flex items-center justify-between gap-3 text-sm">
				<p className="text-gray-10">
					Connect Google Calendar to record meetings automatically
				</p>
				<Button href="/api/integrations/recall-calendar/connect" size="sm">
					Connect
				</Button>
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
				await disconnectCalendarAction({ orgId, calendarRowId: calendar.id });
				toast.success("Calendar disconnected");
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to disconnect",
				);
			}
		});
	};

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
			<span className="inline-flex items-center gap-1.5 text-gray-12">
				<span
					className={classNames(
						"h-1.5 w-1.5 rounded-full",
						calendar.status === "connected" ? "bg-green-500" : "bg-gray-8",
					)}
				/>
				Google Calendar · {calendar.platformEmail ?? "connected"}
			</span>
			<label
				htmlFor={autoRecordId}
				className="flex items-center gap-2 text-xs text-gray-10"
			>
				<Switch
					id={autoRecordId}
					checked={calendar.autoRecord}
					disabled={isPending}
					onCheckedChange={setAutoRecord}
				/>
				Auto-record every meeting with a video link
			</label>
			<button
				type="button"
				className="ml-auto text-xs text-gray-10 hover:underline disabled:opacity-50"
				disabled={isPending}
				onClick={disconnect}
			>
				Disconnect
			</button>
		</div>
	);
}

const RECAP_MODE_OPTIONS: { value: MeetingRecapMode; label: string }[] = [
	{ value: "off", label: "Off" },
	{ value: "self", label: "Just me" },
	{ value: "attendees", label: "Me + attendees" },
];

function RecapPreference({
	orgId,
	initialRecapMode,
}: {
	orgId: Organisation.OrganisationId;
	initialRecapMode: MeetingRecapMode;
}) {
	const [recapMode, setRecapMode] = useState(initialRecapMode);
	const [isPending, startTransition] = useTransition();

	const save = (mode: MeetingRecapMode) => {
		const previous = recapMode;
		setRecapMode(mode);
		startTransition(async () => {
			try {
				await setMeetingPreferences({ orgId, recapMode: mode });
				toast.success("Recap preference saved");
			} catch (error) {
				setRecapMode(previous);
				toast.error(
					error instanceof Error ? error.message : "Failed to save preference",
				);
			}
		});
	};

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-3">
				<span className="text-xs font-medium text-gray-12">Recap email</span>
				<Select
					size="sm"
					value={recapMode}
					onValueChange={(value) => save(value as MeetingRecapMode)}
					disabled={isPending}
					options={RECAP_MODE_OPTIONS}
					placeholder="Recap email"
				/>
			</div>
			<p className="text-xs text-gray-10">
				Sent after the summary is ready. "Me + attendees" emails everyone on the
				calendar invite.
			</p>
		</div>
	);
}

function SlackStrip({ status }: { status: SlackHuddleStatus }) {
	if (status) {
		return (
			<div className="flex items-center gap-3 text-sm">
				<span className="inline-flex items-center gap-1.5 text-gray-12">
					<span
						className={classNames(
							"h-1.5 w-1.5 rounded-full",
							status.status === "active" ? "bg-green-500" : "bg-gray-8",
						)}
					/>
					Slack Huddles · {status.status}
				</span>
			</div>
		);
	}

	return (
		<p className="text-sm text-gray-10">
			Slack Huddle recording is set up in the Recall dashboard (invite the bot's
			email to your workspace)
		</p>
	);
}

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
	bot,
}: {
	orgId: Organisation.OrganisationId;
	bot: MeetingBotRow;
}) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();

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
			</div>
		</div>
	);
}

type UpcomingItem =
	| { kind: "calendar"; key: string; time: Date; event: CalendarEvent }
	| { kind: "bot"; key: string; time: Date; bot: MeetingBotRow };

function UpcomingSection({
	orgId,
	bots,
	settings,
}: {
	orgId: Organisation.OrganisationId;
	bots: MeetingBotRow[];
	settings: CalendarSettings;
}) {
	// Calendar-sourced bots are already represented by settings.upcoming
	// (their "recording" switch is on when a bot row exists for the event).
	const upcomingBots = bots.filter((bot) => bot.source !== "calendar");

	const items: UpcomingItem[] = [
		...settings.upcoming.map((event) => ({
			kind: "calendar" as const,
			key: `c-${event.id}`,
			time: new Date(event.startTime),
			event,
		})),
		...upcomingBots.map((bot) => ({
			kind: "bot" as const,
			key: `b-${bot.id}`,
			time: new Date(bot.joinAt),
			bot,
		})),
	];

	const groups = groupByDay(items, new Date(), (item) => item.time);

	return (
		<div className="flex flex-col gap-2">
			<p className="text-sm font-semibold text-gray-12">Upcoming</p>
			{items.length === 0 ? (
				<p className="text-xs text-gray-10">
					No upcoming meetings with a video link in the next 14 days.
				</p>
			) : (
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
											bot={item.bot}
										/>
									),
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function PastRow({ bot }: { bot: MeetingBotRow }) {
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
			<div className="shrink-0">{result}</div>
		</div>
	);
}

function PastSection({ bots }: { bots: MeetingBotRow[] }) {
	const pastBots = bots;

	return (
		<div className="flex flex-col gap-2">
			<p className="text-sm font-semibold text-gray-12">Past</p>
			{pastBots.length === 0 ? (
				<p className="text-xs text-gray-10">No recordings yet.</p>
			) : (
				<div className="divide-y divide-gray-3">
					{pastBots.map((bot) => (
						<PastRow key={bot.id} bot={bot} />
					))}
				</div>
			)}
		</div>
	);
}

function VocabularyEditor({
	orgId,
	initialTerms,
}: {
	orgId: Organisation.OrganisationId;
	initialTerms: VocabularyTerm[];
}) {
	const router = useRouter();
	const termId = useId();
	const spellingId = useId();
	const [terms, setTerms] = useState(initialTerms);
	const [term, setTerm] = useState("");
	const [spelling, setSpelling] = useState("");
	const [isPending, startTransition] = useTransition();

	useEffect(() => {
		setTerms(initialTerms);
	}, [initialTerms]);

	const handleAdd = () => {
		if (!term.trim()) {
			toast.error("Enter a term");
			return;
		}
		startTransition(async () => {
			try {
				const row = await addMeetingVocabulary({
					orgId,
					term: term.trim(),
					spelling: spelling.trim() || undefined,
				});
				setTerms((prev) => [
					...prev.filter((existing) => existing.id !== row.id),
					row,
				]);
				setTerm("");
				setSpelling("");
				toast.success("Term added");
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to add term",
				);
			}
		});
	};

	const handleRemove = (id: string) => {
		startTransition(async () => {
			try {
				await removeMeetingVocabulary({ orgId, id });
				setTerms((prev) => prev.filter((existing) => existing.id !== id));
				toast.success("Term removed");
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to remove term",
				);
			}
		});
	};

	return (
		<details className="rounded-xl border border-gray-3 p-4">
			<summary className="cursor-pointer text-sm font-medium text-gray-12">
				Transcription vocabulary
			</summary>
			<div className="mt-3 flex flex-col gap-3">
				<p className="text-xs text-gray-10">
					Names, products, and terms the transcript should get right. Optional
					preferred spelling.
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<Input
						id={termId}
						placeholder="Term"
						value={term}
						onChange={(event) => setTerm(event.target.value)}
						className="w-40"
					/>
					<Input
						id={spellingId}
						placeholder="Preferred spelling (optional)"
						value={spelling}
						onChange={(event) => setSpelling(event.target.value)}
						className="w-48"
					/>
					<Button size="sm" onClick={handleAdd} disabled={isPending}>
						Add
					</Button>
				</div>
				{terms.length > 0 && (
					<div className="flex flex-wrap gap-2">
						{terms.map((row) => (
							<span
								key={row.id}
								className="inline-flex items-center gap-1.5 rounded-full border border-gray-3 px-2.5 py-1 text-xs text-gray-12"
							>
								{row.term}
								{row.spelling && (
									<span className="text-gray-10">→ {row.spelling}</span>
								)}
								<button
									type="button"
									onClick={() => handleRemove(row.id)}
									disabled={isPending}
									className="text-gray-10 hover:text-gray-12"
									aria-label={`Remove ${row.term}`}
								>
									×
								</button>
							</span>
						))}
					</div>
				)}
			</div>
		</details>
	);
}

export function MeetingsPage({
	orgId,
	botName,
	initialUpcomingBots,
	initialPastBots,
	calendarSettings,
	slackHuddleStatus,
	initialRecapMode,
	initialVocabulary,
	result,
}: {
	orgId: Organisation.OrganisationId;
	botName: string;
	initialUpcomingBots: MeetingBotRow[];
	initialPastBots: MeetingBotRow[];
	calendarSettings: CalendarSettings;
	slackHuddleStatus: SlackHuddleStatus;
	initialRecapMode: MeetingRecapMode;
	initialVocabulary: VocabularyTerm[];
	result?: string;
}) {
	const router = useRouter();
	const [upcomingBots, setUpcomingBots] = useState(initialUpcomingBots);
	const [pastBots, setPastBots] = useState(initialPastBots);

	useEffect(() => {
		setUpcomingBots(initialUpcomingBots);
	}, [initialUpcomingBots]);

	useEffect(() => {
		setPastBots(initialPastBots);
	}, [initialPastBots]);

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
		const hasPending = upcomingBots.some(
			(bot) => !TERMINAL_STATUSES.has(bot.status),
		);
		if (!hasPending) return;
		const interval = setInterval(() => router.refresh(), 15000);
		return () => clearInterval(interval);
	}, [upcomingBots, router]);

	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-4">
			{calendarSettings.configured ? (
				<SendBotBar
					orgId={orgId}
					botName={botName}
					onScheduled={() => router.refresh()}
				/>
			) : (
				<p className="text-xs text-gray-10">
					Meeting bots aren't configured on this deployment.
				</p>
			)}
			<CalendarStrip orgId={orgId} settings={calendarSettings} />
			<RecapPreference orgId={orgId} initialRecapMode={initialRecapMode} />
			<SlackStrip status={slackHuddleStatus} />
			<UpcomingSection
				orgId={orgId}
				bots={upcomingBots}
				settings={calendarSettings}
			/>
			<PastSection bots={pastBots} />
			<VocabularyEditor orgId={orgId} initialTerms={initialVocabulary} />
		</div>
	);
}
