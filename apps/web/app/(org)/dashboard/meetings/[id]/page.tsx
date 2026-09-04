import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { meetingBots } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import { canManageOrganizationSettings } from "@/lib/permissions/roles";
import { readLiveTranscript } from "@/lib/recall/live-transcript";
import { canUserAccessMeetingBot } from "@/lib/recall/visibility";
import { LiveMeeting } from "./LiveMeeting";

export default async function Page({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) redirect("/dashboard/meetings");
	const access = await requireOrganizationAccess(
		user.id,
		user.activeOrganizationId,
	);
	const { id } = await params;
	const [meeting] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.id, id))
		.limit(1);
	if (!meeting || meeting.orgId !== user.activeOrganizationId) notFound();
	if (
		!canManageOrganizationSettings(access.role) &&
		!(await canUserAccessMeetingBot(meeting.id, user.id))
	) {
		notFound();
	}
	const transcript = await readLiveTranscript(meeting.id).catch(() => null);
	return (
		<LiveMeeting
			orgId={meeting.orgId}
			meetingBotId={meeting.id}
			title={meeting.title ?? "Meeting"}
			status={meeting.status}
			utterances={transcript?.utterances ?? []}
		/>
	);
}
