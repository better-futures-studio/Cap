import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
	getMeetingCalendarSettings,
	listMeetingBots,
} from "@/actions/meetings";
import { MeetingsPage } from "./MeetingsPage";

export const metadata: Metadata = {
	title: "Meetings — Cap",
};

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ calendar?: string }>;
}) {
	const user = await getCurrentUser();

	if (!user) {
		redirect("/auth/signin");
	}

	if (!user.activeOrganizationId) {
		redirect("/dashboard/caps");
	}

	const [bots, calendarSettings] = await Promise.all([
		listMeetingBots({ orgId: user.activeOrganizationId }),
		getMeetingCalendarSettings({ orgId: user.activeOrganizationId }),
	]);
	const { calendar } = await searchParams;

	return (
		<MeetingsPage
			orgId={user.activeOrganizationId}
			initialBots={bots}
			calendarSettings={calendarSettings}
			result={calendar}
		/>
	);
}
