"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	type MeetingBotStatus,
	type MeetingRecapMode,
	meetingBots,
	meetingPreferences,
	slackHuddleTeams,
	videoUploads,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, asc, desc, eq, gte, inArray, lt, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import { getMeetingActionItems } from "@/lib/recall/action-items";
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
	setCalendarSeriesRule,
	toggleCalendarEventRecording,
} from "@/lib/recall/calendars";
import {
	isRecallCalendarConfigured,
	isRecallConfigured,
} from "@/lib/recall/config";
import { parseRecapMode } from "@/lib/recall/recap";

const MEETINGS_PATH = "/dashboard/meetings";

const NON_TERMINAL_STATUSES: MeetingBotStatus[] = [
	"scheduling",
	"scheduled",
	"joining_call",
	"in_waiting_room",
	"in_call_not_recording",
	"in_call_recording",
];

const TERMINAL_STATUSES: MeetingBotStatus[] = [
	"complete",
	"fatal",
	"failed",
	"cancelled",
	"opted_out",
];

const UPCOMING_JOIN_AT_GRACE_MS = 2 * 60 * 60 * 1000;

const MEETING_BOT_COLUMNS = {
	id: meetingBots.id,
	ownerId: meetingBots.ownerId,
	title: meetingBots.title,
	meetingUrl: meetingBots.meetingUrl,
	joinAt: meetingBots.joinAt,
	source: meetingBots.source,
	status: meetingBots.status,
	errorMessage: meetingBots.errorMessage,
	videoId: meetingBots.videoId,
	createdAt: meetingBots.createdAt,
	pendingUploadVideoId: videoUploads.videoId,
};

const withVideoReady = <
	T extends { videoId: string | null; pendingUploadVideoId: string | null },
>(
	rows: T[],
) =>
	rows.map(({ pendingUploadVideoId, ...row }) => ({
		...row,
		videoReady: row.videoId !== null && pendingUploadVideoId === null,
	}));

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

	const cutoff = new Date(Date.now() - UPCOMING_JOIN_AT_GRACE_MS);

	const upcomingRows = await db()
		.select(MEETING_BOT_COLUMNS)
		.from(meetingBots)
		.leftJoin(videoUploads, eq(videoUploads.videoId, meetingBots.videoId))
		.where(
			and(
				eq(meetingBots.orgId, orgId),
				inArray(meetingBots.status, NON_TERMINAL_STATUSES),
				gte(meetingBots.joinAt, cutoff),
			),
		)
		.orderBy(asc(meetingBots.joinAt))
		.limit(100);

	const pastRows = await db()
		.select(MEETING_BOT_COLUMNS)
		.from(meetingBots)
		.leftJoin(videoUploads, eq(videoUploads.videoId, meetingBots.videoId))
		.where(
			and(
				eq(meetingBots.orgId, orgId),
				or(
					inArray(meetingBots.status, TERMINAL_STATUSES),
					lt(meetingBots.joinAt, cutoff),
				),
			),
		)
		.orderBy(desc(meetingBots.joinAt))
		.limit(50);

	return {
		upcoming: withVideoReady(upcomingRows),
		past: withVideoReady(pastRows),
	};
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

export async function setCalendarSeriesRuleAction({
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
	await setCalendarSeriesRule({
		calendarRowId,
		userId: user.id,
		eventId,
		record,
	});
	revalidatePath(MEETINGS_PATH);
}

export async function getMeetingPreferences({
	orgId,
}: {
	orgId: Organisation.OrganisationId;
}): Promise<{ recapMode: MeetingRecapMode }> {
	const user = await requireUser(orgId);
	const [row] = await db()
		.select({ recapMode: meetingPreferences.recapMode })
		.from(meetingPreferences)
		.where(eq(meetingPreferences.userId, user.id))
		.limit(1);
	return { recapMode: parseRecapMode(row?.recapMode) };
}

export async function setMeetingPreferences({
	orgId,
	recapMode,
}: {
	orgId: Organisation.OrganisationId;
	recapMode: MeetingRecapMode;
}) {
	const user = await requireUser(orgId);
	const mode = parseRecapMode(recapMode);
	if (mode !== recapMode) throw new Error("Invalid recap mode");
	await db()
		.insert(meetingPreferences)
		.values({
			userId: user.id,
			orgId,
			recapMode: mode,
		})
		.onDuplicateKeyUpdate({
			set: { recapMode: mode, orgId },
		});
	revalidatePath(MEETINGS_PATH);
	return { recapMode: mode };
}

export async function getMeetingActionItemsAction({
	orgId,
	videoId,
}: {
	orgId: Organisation.OrganisationId;
	videoId: string;
}) {
	await requireUser(orgId);
	return getMeetingActionItems(videoId);
}

export async function getSlackHuddleStatus({
	orgId,
}: {
	orgId: Organisation.OrganisationId;
}) {
	await requireUser(orgId);
	const [row] = await db()
		.select({ status: slackHuddleTeams.status })
		.from(slackHuddleTeams)
		.where(eq(slackHuddleTeams.orgId, orgId))
		.orderBy(desc(slackHuddleTeams.createdAt))
		.limit(1);
	return row ?? null;
}
