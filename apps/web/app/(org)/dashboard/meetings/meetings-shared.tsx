import type { MeetingBotStatus } from "@cap/database/schema";
import type {
	getMeetingCalendarSettings,
	getSlackHuddleStatus,
	listMeetingBots,
	listMeetingVocabulary,
} from "@/actions/meetings";

export type MeetingBotRow = Awaited<
	ReturnType<typeof listMeetingBots>
>["upcoming"][number];
export type CalendarSettings = Awaited<
	ReturnType<typeof getMeetingCalendarSettings>
>;
export type CalendarEvent = CalendarSettings["upcoming"][number];
export type SlackHuddleStatus = Awaited<
	ReturnType<typeof getSlackHuddleStatus>
>;
export type VocabularyTerm = Awaited<
	ReturnType<typeof listMeetingVocabulary>
>[number];

export const TERMINAL_STATUSES = new Set<MeetingBotStatus>([
	"complete",
	"fatal",
	"failed",
	"cancelled",
	"opted_out",
]);

export const CANCELLABLE_STATUSES = new Set<MeetingBotStatus>([
	"scheduling",
	"scheduled",
]);

export const calendarResultMessages: Record<
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

export function botStatusLabel(status: MeetingBotStatus): string {
	if (status === "scheduling" || status === "scheduled") return "Bot scheduled";
	if (status === "joining_call" || status === "in_waiting_room")
		return "Joining…";
	return "Recording now";
}

export function formatTime(date: Date): string {
	return date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}

export function formatPastDate(date: Date): string {
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export type UpcomingItem =
	| { kind: "calendar"; key: string; time: Date; event: CalendarEvent }
	| { kind: "bot"; key: string; time: Date; bot: MeetingBotRow };

/** Calendar-sourced bots are already represented by settings.upcoming
 * (their "recording" switch is on when a bot row exists for the event). */
export function buildUpcomingItems(
	bots: MeetingBotRow[],
	settings: CalendarSettings,
): UpcomingItem[] {
	const upcomingBots = bots.filter((bot) => bot.source !== "calendar");
	return [
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
}
