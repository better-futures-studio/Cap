import { db } from "@cap/database";
import {
	meetingBots,
	organizationMembers,
	spaceMembers,
	spaces,
	spaceVideos,
	users,
	videoShares,
	videos,
} from "@cap/database/schema";
import type { Organisation, Space, User, Video } from "@cap/web-domain";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { RecallCalendarEvent, RecallClient } from "./client";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";
import { sharedMeetingSubCode } from "./shared-recording";

const RESOURCE_EMAIL = /@resource\.calendar\.google\.com$/i;

export const MEETING_VIDEO_PUBLIC = false;

export function meetingVideoIsPublic(): boolean {
	return MEETING_VIDEO_PUBLIC;
}

export function meetingSpaceName(title: string | null, date: Date): string {
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

async function insertMeetingShares({
	videoId,
	ownerId,
	attendeeIds,
}: {
	videoId: Video.VideoId;
	ownerId: User.UserId;
	attendeeIds: User.UserId[];
}): Promise<void> {
	const values = attendeeIds
		.filter((userId) => userId !== ownerId)
		.map((userId) => ({
			videoId,
			userId,
			sharedByUserId: ownerId,
			source: "meeting" as const,
		}));
	if (values.length === 0) return;
	await db().insert(videoShares).ignore().values(values);
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
				videoId: meetingBots.videoId,
				calendarEventId: meetingBots.calendarEventId,
			})
			.from(meetingBots)
			.where(eq(meetingBots.id, meetingBotId))
			.limit(1);
		if (!primary?.videoId) return;

		const attendeeIds = await resolveMeetingAttendeeUserIds({
			meetingBotId,
			orgId: primary.orgId,
			calendarEventId: primary.calendarEventId,
			client: deps.client,
		});
		await insertMeetingShares({
			videoId: primary.videoId,
			ownerId: primary.ownerId,
			attendeeIds,
		});
	} catch (error) {
		console.error("[recall] share recording with attendees failed", {
			meetingBotId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

function pickPrimaryMeetingBotId(
	bots: { id: string; statusSubCode: string | null }[],
): string | undefined {
	const sharedFrom = bots
		.map((bot) => bot.statusSubCode?.match(/^shared:(.+)$/)?.[1])
		.find((id): id is string => Boolean(id));
	if (sharedFrom && bots.some((bot) => bot.id === sharedFrom))
		return sharedFrom;
	const primary = bots.find((bot) => !bot.statusSubCode?.startsWith("shared:"));
	return primary?.id ?? bots[0]?.id;
}

async function copySpaceMembersToShares({
	spaceId,
	videoId,
	ownerId,
}: {
	spaceId: Space.SpaceIdOrOrganisationId;
	videoId: Video.VideoId;
	ownerId: User.UserId;
}): Promise<void> {
	const members = await db()
		.select({ userId: spaceMembers.userId })
		.from(spaceMembers)
		.where(eq(spaceMembers.spaceId, spaceId))
		.limit(200);
	await insertMeetingShares({
		videoId,
		ownerId,
		attendeeIds: members.map((row) => row.userId),
	});
}

async function detachMeetingVideoFromSpace({
	spaceId,
	videoId,
}: {
	spaceId: Space.SpaceIdOrOrganisationId;
	videoId: Video.VideoId;
}): Promise<void> {
	await db()
		.delete(spaceVideos)
		.where(
			and(eq(spaceVideos.spaceId, spaceId), eq(spaceVideos.videoId, videoId)),
		);
	const [remaining] = await db()
		.select({ id: spaceVideos.id })
		.from(spaceVideos)
		.where(eq(spaceVideos.spaceId, spaceId))
		.limit(1);
	if (remaining) return;
	await db().delete(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
	await db().delete(spaces).where(eq(spaces.id, spaceId));
}

export async function migrateMeetingSpacesToVideoShares(
	deps: { client?: RecallClient } = {},
): Promise<{ spacesMigrated: number; videosPrivatized: number }> {
	const spaceCandidates = await db()
		.select({
			spaceId: spaces.id,
			spaceName: spaces.name,
			privacy: spaces.privacy,
			public: spaces.public,
			videoId: spaceVideos.videoId,
			ownerId: videos.ownerId,
			title: meetingBots.title,
			joinAt: meetingBots.joinAt,
			meetingBotId: meetingBots.id,
			statusSubCode: meetingBots.statusSubCode,
		})
		.from(spaceVideos)
		.innerJoin(meetingBots, eq(meetingBots.videoId, spaceVideos.videoId))
		.innerJoin(spaces, eq(spaces.id, spaceVideos.spaceId))
		.innerJoin(videos, eq(videos.id, spaceVideos.videoId))
		.where(and(eq(spaces.privacy, "Private"), eq(spaces.public, false)))
		.limit(200);

	const meetingSpaces = new Map<
		string,
		{
			spaceId: Space.SpaceIdOrOrganisationId;
			videoId: Video.VideoId;
			ownerId: User.UserId;
			bots: { id: string; statusSubCode: string | null }[];
		}
	>();
	for (const row of spaceCandidates) {
		if (!row.videoId) continue;
		if (row.spaceName !== meetingSpaceName(row.title, row.joinAt)) continue;
		const key = `${row.spaceId}:${row.videoId}`;
		const existing = meetingSpaces.get(key);
		if (existing) {
			existing.bots.push({
				id: row.meetingBotId,
				statusSubCode: row.statusSubCode,
			});
			continue;
		}
		meetingSpaces.set(key, {
			spaceId: row.spaceId,
			videoId: row.videoId,
			ownerId: row.ownerId,
			bots: [{ id: row.meetingBotId, statusSubCode: row.statusSubCode }],
		});
	}

	const publicMeetingVideos = await db()
		.select({
			videoId: meetingBots.videoId,
			ownerId: videos.ownerId,
			meetingBotId: meetingBots.id,
			statusSubCode: meetingBots.statusSubCode,
		})
		.from(meetingBots)
		.innerJoin(videos, eq(videos.id, meetingBots.videoId))
		.where(and(isNotNull(meetingBots.videoId), eq(videos.public, true)))
		.limit(200);

	if (meetingSpaces.size === 0 && publicMeetingVideos.length === 0) {
		return { spacesMigrated: 0, videosPrivatized: 0 };
	}

	const privatizeIds = new Set<Video.VideoId>();
	const shareBotIds = new Set<string>();
	const spacesSeen = new Set<string>();

	for (const row of meetingSpaces.values()) {
		try {
			await copySpaceMembersToShares({
				spaceId: row.spaceId,
				videoId: row.videoId,
				ownerId: row.ownerId,
			});
			await detachMeetingVideoFromSpace({
				spaceId: row.spaceId,
				videoId: row.videoId,
			});
			privatizeIds.add(row.videoId);
			const botId = pickPrimaryMeetingBotId(row.bots);
			if (botId) shareBotIds.add(botId);
			spacesSeen.add(row.spaceId);
		} catch (error) {
			console.error("[recall] meeting space share migration failed", {
				spaceId: row.spaceId,
				videoId: row.videoId,
				error: error instanceof Error ? error.message : "unknown",
			});
		}
	}

	const publicByVideo = new Map<
		string,
		{
			videoId: Video.VideoId;
			bots: { id: string; statusSubCode: string | null }[];
		}
	>();
	for (const row of publicMeetingVideos) {
		if (!row.videoId) continue;
		const existing = publicByVideo.get(row.videoId);
		if (existing) {
			existing.bots.push({
				id: row.meetingBotId,
				statusSubCode: row.statusSubCode,
			});
			continue;
		}
		publicByVideo.set(row.videoId, {
			videoId: row.videoId,
			bots: [{ id: row.meetingBotId, statusSubCode: row.statusSubCode }],
		});
	}

	for (const row of publicByVideo.values()) {
		privatizeIds.add(row.videoId);
		const botId = pickPrimaryMeetingBotId(row.bots);
		if (botId) shareBotIds.add(botId);
	}

	if (privatizeIds.size > 0) {
		await db()
			.update(videos)
			.set({ public: false })
			.where(inArray(videos.id, [...privatizeIds]));
	}

	for (const meetingBotId of shareBotIds) {
		await shareMeetingRecordingWithAttendees(meetingBotId, {
			client: deps.client,
		});
	}

	return {
		spacesMigrated: spacesSeen.size,
		videosPrivatized: privatizeIds.size,
	};
}
