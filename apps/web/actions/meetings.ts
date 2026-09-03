"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { meetingBots, videoUploads } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import {
	cancelMeetingBot,
	parseMeetingUrl,
	scheduleManualMeetingBot,
} from "@/lib/recall/bots";
import {
	disconnectCalendar,
	getUserCalendar,
	listUpcomingCalendarEvents,
	setCalendarAutoRecord,
	toggleCalendarEventRecording,
} from "@/lib/recall/calendars";
import {
	isRecallCalendarConfigured,
	isRecallConfigured,
} from "@/lib/recall/config";

const MEETINGS_PATH = "/dashboard/meetings";

const requireUser = async (orgId: Organisation.OrganisationId) => {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	await requireOrganizationAccess(user.id, orgId);
	return user;
};

export async function scheduleMeetingBot({
	orgId,
	meetingUrl,
	joinAt,
	title,
}: {
	orgId: Organisation.OrganisationId;
	meetingUrl: string;
	joinAt?: string;
	title?: string;
}) {
	const user = await requireUser(orgId);
	if (!parseMeetingUrl(meetingUrl)) {
		throw new Error("Unsupported meeting URL");
	}
	const result = await scheduleManualMeetingBot({
		orgId,
		userId: user.id,
		meetingUrl,
		joinAt: joinAt ? new Date(joinAt) : undefined,
		title,
	});
	revalidatePath(MEETINGS_PATH);
	return result;
}

export async function cancelMeetingBotAction({
	orgId,
	id,
}: {
	orgId: Organisation.OrganisationId;
	id: string;
}) {
	const user = await requireUser(orgId);
	await cancelMeetingBot({ id, orgId, userId: user.id });
	revalidatePath(MEETINGS_PATH);
}

export async function listMeetingBots({
	orgId,
}: {
	orgId: Organisation.OrganisationId;
}) {
	await requireUser(orgId);

	const rows = await db()
		.select({
			id: meetingBots.id,
			title: meetingBots.title,
			meetingUrl: meetingBots.meetingUrl,
			joinAt: meetingBots.joinAt,
			source: meetingBots.source,
			status: meetingBots.status,
			errorMessage: meetingBots.errorMessage,
			videoId: meetingBots.videoId,
			createdAt: meetingBots.createdAt,
			pendingUploadVideoId: videoUploads.videoId,
		})
		.from(meetingBots)
		.leftJoin(videoUploads, eq(videoUploads.videoId, meetingBots.videoId))
		.where(eq(meetingBots.orgId, orgId))
		.orderBy(desc(meetingBots.createdAt))
		.limit(50);

	return rows.map(({ pendingUploadVideoId, ...row }) => ({
		...row,
		videoReady: row.videoId !== null && pendingUploadVideoId === null,
	}));
}

export async function getMeetingCalendarSettings({
	orgId,
}: {
	orgId: Organisation.OrganisationId;
}) {
	const user = await requireUser(orgId);

	const calendarRow = await getUserCalendar({ orgId, userId: user.id });
	const calendar = calendarRow
		? {
				id: calendarRow.id,
				platformEmail: calendarRow.platformEmail,
				status: calendarRow.status,
				autoRecord: calendarRow.autoRecord,
			}
		: null;
	const upcoming = calendarRow
		? await listUpcomingCalendarEvents({ calendarRowId: calendarRow.id })
		: [];

	return {
		configured: isRecallConfigured(),
		calendarConfigured: isRecallCalendarConfigured(),
		calendar,
		upcoming,
	};
}

export async function setCalendarAutoRecordAction({
	orgId,
	calendarRowId,
	autoRecord,
}: {
	orgId: Organisation.OrganisationId;
	calendarRowId: string;
	autoRecord: boolean;
}) {
	const user = await requireUser(orgId);
	await setCalendarAutoRecord({ calendarRowId, userId: user.id, autoRecord });
	revalidatePath(MEETINGS_PATH);
}

export async function toggleCalendarEventRecordingAction({
	orgId,
	calendarRowId,
	eventId,
	record,
}: {
	orgId: Organisation.OrganisationId;
	calendarRowId: string;
	eventId: string;
	record: boolean;
}) {
	const user = await requireUser(orgId);
	await toggleCalendarEventRecording({
		calendarRowId,
		userId: user.id,
		eventId,
		record,
	});
	revalidatePath(MEETINGS_PATH);
}

export async function disconnectCalendarAction({
	orgId,
	calendarRowId,
}: {
	orgId: Organisation.OrganisationId;
	calendarRowId: string;
}) {
	const user = await requireUser(orgId);
	await disconnectCalendar({ calendarRowId, userId: user.id });
	revalidatePath(MEETINGS_PATH);
}
