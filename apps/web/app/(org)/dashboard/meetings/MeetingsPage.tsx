"use client";

import type { MeetingRecapMode } from "@cap/database/schema";
import { Button, Input } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { scheduleMeetingBot } from "@/actions/meetings";
import { MeetingsTabs } from "./MeetingsTabs";
import {
	buildUpcomingItems,
	type CalendarSettings,
	calendarResultMessages,
	type MeetingBotRow,
	type SlackHuddleStatus,
	TERMINAL_STATUSES,
	type VocabularyTerm,
} from "./meetings-shared";
import { PastTab } from "./PastTab";
import { SettingsTab } from "./SettingsTab";
import { UpcomingTab } from "./UpcomingTab";

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

const TAB_KEYS = ["upcoming", "past", "settings"] as const;
type TabKey = (typeof TAB_KEYS)[number];

function readTab(value: string | null): TabKey {
	return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : "upcoming";
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
	const searchParams = useSearchParams();
	const activeTab = readTab(searchParams.get("tab"));
	const [upcomingBots, setUpcomingBots] = useState(initialUpcomingBots);
	const [pastBots, setPastBots] = useState(initialPastBots);

	useEffect(() => {
		setUpcomingBots(initialUpcomingBots);
	}, [initialUpcomingBots]);

	useEffect(() => {
		setPastBots(initialPastBots);
	}, [initialPastBots]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when the server-provided result changes, not on every tab switch
	useEffect(() => {
		if (!result) return;
		const notification = calendarResultMessages[result];
		if (notification?.type === "success") {
			toast.success(notification.message);
		} else if (notification) {
			toast.error(notification.message);
		}
		const params = new URLSearchParams(searchParams);
		params.delete("calendar");
		const query = params.toString();
		router.replace(`/dashboard/meetings${query ? `?${query}` : ""}`);
	}, [result, router]);

	useEffect(() => {
		const hasPending = upcomingBots.some(
			(bot) => !TERMINAL_STATUSES.has(bot.status),
		);
		if (!hasPending) return;
		const interval = setInterval(() => router.refresh(), 15000);
		return () => clearInterval(interval);
	}, [upcomingBots, router]);

	const setActiveTab = (tab: string) => {
		const params = new URLSearchParams(searchParams);
		if (tab === "upcoming") params.delete("tab");
		else params.set("tab", tab);
		const query = params.toString();
		router.replace(`/dashboard/meetings${query ? `?${query}` : ""}`);
	};

	const upcomingItems = buildUpcomingItems(upcomingBots, calendarSettings);

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
			<MeetingsTabs
				tabs={[
					{ key: "upcoming", label: "Upcoming", count: upcomingItems.length },
					{ key: "past", label: "Past", count: pastBots.length },
					{ key: "settings", label: "Settings" },
				]}
				active={activeTab}
				onChange={setActiveTab}
			/>
			<div role="tabpanel">
				{activeTab === "upcoming" && (
					<UpcomingTab
						orgId={orgId}
						items={upcomingItems}
						settings={calendarSettings}
					/>
				)}
				{activeTab === "past" && <PastTab bots={pastBots} />}
				{activeTab === "settings" && (
					<SettingsTab
						orgId={orgId}
						calendarSettings={calendarSettings}
						slackHuddleStatus={slackHuddleStatus}
						initialRecapMode={initialRecapMode}
						initialVocabulary={initialVocabulary}
					/>
				)}
			</div>
		</div>
	);
}
