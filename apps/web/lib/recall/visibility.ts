import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	meetingBots,
	organizationMembers,
	spaceMembers,
	spaces,
	spaceVideos,
	users,
} from "@cap/database/schema";
import {
	type Organisation,
	Space,
	SpaceMemberId,
	type User,
	type Video,
} from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { RecallCalendarEvent, RecallClient } from "./client";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";
import { sharedMeetingSubCode } from "./shared-recording";

const RESOURCE_EMAIL = /@resource\.calendar\.google\.com$/i;

export const MEETING_VIDEO_PUBLIC = false;

export function meetingVideoIsPublic(): boolean {
	return MEETING_VIDEO_PUBLIC;
}

function meetingSpaceName(title: string | null, date: Date): string {
	if (title?.trim()) return title.trim().slice(0, 255);
	const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
		month: "long",
	})} ${date.getFullYear()}`;
	return `Meeting - ${formattedDate}`.slice(0, 255);
}

function calendarInviteEmails(
	event: RecallCalendarEvent,
	botName: string,
): string[] {
	const raw = event.raw;
	if (!raw || typeof raw !== "object" || !("attendees" in raw)) return [];
	const attendees = (raw as { attendees?: unknown }).attendees;
	if (!Array.isArray(attendees)) return [];
	const bot = botName.trim().toLowerCase();
	return attendees.flatMap((attendee) => {
		if (!attendee || typeof attendee !== "object") return [];
		const row = attendee as {
			email?: string;
			resource?: boolean;
			displayName?: string;
		};
		const email = row.email?.trim() ?? "";
		if (!email) return [];
		if (
			row.resource ||
			RESOURCE_EMAIL.test(email) ||
			/\b(conference room|meeting room)\b/.test(
				`${row.displayName ?? ""} ${email}`.toLowerCase(),
			)
		) {
			return [];
		}
		const display = (row.displayName ?? "").trim().toLowerCase();
		if (bot && (display === bot || email.toLowerCase().includes(bot))) {
			return [];
		}
		return [email.toLowerCase()];
	});
}

export async function resolveMeetingAttendeeUserIds({
	meetingBotId,
	orgId,
	calendarEventId,
	client,
}: {
	meetingBotId: string;
	orgId: Organisation.OrganisationId;
	calendarEventId: string | null;
	client?: RecallClient;
}): Promise<User.UserId[]> {
	const ids = new Set<User.UserId>();

	const sharedOwners = await db()
		.select({ ownerId: meetingBots.ownerId })
		.from(meetingBots)
		.where(eq(meetingBots.statusSubCode, sharedMeetingSubCode(meetingBotId)))
		.limit(200);
	for (const row of sharedOwners) ids.add(row.ownerId);

	if (!calendarEventId) return [...ids];

	const recall = client ?? getDefaultRecallClient();
	const botName = getRecallConfig()?.botName ?? DEFAULT_BOT_NAME;
	let emails: string[] = [];
	try {
		const event = await recall.getCalendarEvent(calendarEventId);
		emails = calendarInviteEmails(event, botName);
	} catch {
		return [...ids];
	}
	if (emails.length === 0) return [...ids];

	const members = await db()
		.select({ userId: users.id, email: users.email })
		.from(users)
		.innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
		.where(eq(organizationMembers.organizationId, orgId))
		.limit(500);
	const wanted = new Set(emails);
	for (const row of members) {
		if (wanted.has(row.email.trim().toLowerCase())) ids.add(row.userId);
	}
	return [...ids];
}

async function existingMeetingSpaceId(
	videoId: Video.VideoId,
): Promise<Space.SpaceIdOrOrganisationId | null> {
	const [row] = await db()
		.select({ spaceId: spaceVideos.spaceId })
		.from(spaceVideos)
		.where(eq(spaceVideos.videoId, videoId))
		.limit(1);
	return row?.spaceId ?? null;
}

async function ensureSpaceMembers({
	spaceId,
	ownerId,
	attendeeIds,
}: {
	spaceId: Space.SpaceIdOrOrganisationId;
	ownerId: User.UserId;
	attendeeIds: User.UserId[];
}): Promise<void> {
	const existing = await db()
		.select({ userId: spaceMembers.userId })
		.from(spaceMembers)
		.where(eq(spaceMembers.spaceId, spaceId))
		.limit(200);
	const present = new Set(existing.map((row) => row.userId));
	const values: {
		id: SpaceMemberId;
		spaceId: Space.SpaceIdOrOrganisationId;
		userId: User.UserId;
		role: "admin" | "member";
	}[] = [];

	if (!present.has(ownerId)) {
		values.push({
			id: SpaceMemberId.make(nanoId()),
			spaceId,
			userId: ownerId,
			role: "admin",
		});
		present.add(ownerId);
	}

	for (const userId of attendeeIds) {
		if (present.has(userId)) continue;
		values.push({
			id: SpaceMemberId.make(nanoId()),
			spaceId,
			userId,
			role: userId === ownerId ? "admin" : "member",
		});
		present.add(userId);
	}

	if (values.length === 0) return;
	await db().insert(spaceMembers).values(values);
}

async function ensureSpaceVideo({
	spaceId,
	videoId,
	addedById,
}: {
	spaceId: Space.SpaceIdOrOrganisationId;
	videoId: Video.VideoId;
	addedById: User.UserId;
}): Promise<void> {
	const [existing] = await db()
		.select({ id: spaceVideos.id })
		.from(spaceVideos)
		.where(
			and(eq(spaceVideos.spaceId, spaceId), eq(spaceVideos.videoId, videoId)),
		)
		.limit(1);
	if (existing) return;
	await db().insert(spaceVideos).values({
		id: nanoId(),
		spaceId,
		videoId,
		addedById,
	});
}

export async function shareMeetingRecordingWithAttendees(
	meetingBotId: string,
	deps: { client?: RecallClient } = {},
): Promise<void> {
	try {
		const [primary] = await db()
			.select({
				ownerId: meetingBots.ownerId,
				orgId: meetingBots.orgId,
				title: meetingBots.title,
				joinAt: meetingBots.joinAt,
				videoId: meetingBots.videoId,
				calendarEventId: meetingBots.calendarEventId,
			})
			.from(meetingBots)
			.where(eq(meetingBots.id, meetingBotId))
			.limit(1);
		if (!primary?.videoId) return;

		const videoId = primary.videoId;
		const attendeeIds = await resolveMeetingAttendeeUserIds({
			meetingBotId,
			orgId: primary.orgId,
			calendarEventId: primary.calendarEventId,
			client: deps.client,
		});

		let spaceId = await existingMeetingSpaceId(videoId);
		if (!spaceId) {
			spaceId = Space.SpaceId.make(nanoId());
			await db()
				.insert(spaces)
				.values({
					id: spaceId,
					name: meetingSpaceName(primary.title, primary.joinAt),
					organizationId: primary.orgId,
					createdById: primary.ownerId,
					privacy: "Private",
					public: false,
				});
		}

		await ensureSpaceMembers({
			spaceId,
			ownerId: primary.ownerId,
			attendeeIds,
		});
		await ensureSpaceVideo({
			spaceId,
			videoId,
			addedById: primary.ownerId,
		});
	} catch (error) {
		console.error("[recall] share recording with attendees failed", {
			meetingBotId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}
