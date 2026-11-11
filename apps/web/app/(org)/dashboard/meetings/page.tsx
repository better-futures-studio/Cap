import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
	getMeetingCalendarSettings,
	getMeetingPreferences,
	getSlackHuddleStatus,
	listMeetingBots,
	listMeetingVocabulary,
} from "@/actions/meetings";
import { DEFAULT_BOT_NAME, getRecallConfig } from "@/lib/recall/config";
import { readRecordingFilters } from "@/lib/recordings/filters";
import { MeetingsPage } from "./MeetingsPage";

export const metadata: Metadata = {
	title: "Meetings — Cap",
};

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const user = await getCurrentUser();

	if (!user) {
		redirect("/auth/signin");
	}

	if (!user.activeOrganizationId) {
		redirect("/dashboard/caps");
	}

	const params = await searchParams;
	const filters = readRecordingFilters(params);
	const [
		bots,
		calendarSettings,
		slackHuddleStatus,
		meetingPreferences,
		vocabulary,
	] = await Promise.all([
		listMeetingBots({
			orgId: user.activeOrganizationId,
			filters,
			pastPage: typeof params.page === "string" ? params.page : "1",
		}),
		getMeetingCalendarSettings({ orgId: user.activeOrganizationId }),
		getSlackHuddleStatus({ orgId: user.activeOrganizationId }),
		getMeetingPreferences({ orgId: user.activeOrganizationId }),
		listMeetingVocabulary({ orgId: user.activeOrganizationId }),
	]);
	const calendar =
		typeof params.calendar === "string" ? params.calendar : undefined;

	return (
		<MeetingsPage
			orgId={user.activeOrganizationId}
			userId={user.id}
			botName={getRecallConfig()?.botName ?? DEFAULT_BOT_NAME}
			initialUpcomingBots={bots.upcoming}
			initialPastBots={bots.past}
			pastHasMore={bots.pastHasMore}
			pastPage={bots.pastPage}
			calendarSettings={calendarSettings}
			slackHuddleStatus={slackHuddleStatus}
			initialRecapMode={meetingPreferences.recapMode}
			initialVocabulary={vocabulary}
			result={calendar}
		/>
	);
}
