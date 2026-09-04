"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	users,
	videoShares,
	videos,
} from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import { and, eq, notInArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { canManageOrganizationSettings } from "@/lib/permissions/roles";

export type VideoShareSource = "owner" | "meeting" | "manual";

export type VideoSharePerson = {
	id: User.UserId;
	name: string | null;
	email: string;
	source: VideoShareSource;
};

export type VideoShareCandidate = {
	id: User.UserId;
	name: string | null;
	email: string;
};

async function requireSignedInUser() {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	return user;
}

async function requireVideo(videoId: Video.VideoId) {
	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			orgId: videos.orgId,
		})
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!video) throw new Error("Video not found");
	return video;
}

async function requireVideoShareManager(videoId: Video.VideoId) {
	const user = await requireSignedInUser();
	const video = await requireVideo(videoId);
	if (video.ownerId === user.id) return { user, video };
	const access = await getOrganizationAccess(user.id, video.orgId);
	if (!access || !canManageOrganizationSettings(access.role)) {
		throw new Error(
			"You don't have permission to manage sharing for this video",
		);
	}
	return { user, video };
}

export async function listVideoShares({
	videoId,
}: {
	videoId: Video.VideoId;
}): Promise<{
	people: VideoSharePerson[];
	candidates: VideoShareCandidate[];
}> {
	const { video } = await requireVideoShareManager(videoId);

	const [owner] = await db()
		.select({
			id: users.id,
			name: users.name,
			email: users.email,
		})
		.from(users)
		.where(eq(users.id, video.ownerId))
		.limit(1);
	if (!owner) throw new Error("Video owner not found");

	const shares = await db()
		.select({
			id: users.id,
			name: users.name,
			email: users.email,
			source: videoShares.source,
		})
		.from(videoShares)
		.innerJoin(users, eq(videoShares.userId, users.id))
		.where(eq(videoShares.videoId, videoId));

	const people: VideoSharePerson[] = [
		{ ...owner, source: "owner" },
		...shares
			.filter((row) => row.id !== owner.id)
			.map((row) => ({
				id: row.id,
				name: row.name,
				email: row.email,
				source: row.source,
			})),
	];

	const excludedIds = people.map((person) => person.id);
	const candidates = await db()
		.select({
			id: users.id,
			name: users.name,
			email: users.email,
		})
		.from(organizationMembers)
		.innerJoin(users, eq(organizationMembers.userId, users.id))
		.where(
			and(
				eq(organizationMembers.organizationId, video.orgId),
				excludedIds.length > 0
					? notInArray(organizationMembers.userId, excludedIds)
					: undefined,
			),
		);

	return { people, candidates };
}

export async function addVideoShare({
	videoId,
	userId,
}: {
	videoId: Video.VideoId;
	userId: User.UserId;
}): Promise<{ success: true }> {
	const { user, video } = await requireVideoShareManager(videoId);
	if (userId === video.ownerId) return { success: true };

	const [member] = await db()
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.userId, userId),
				eq(organizationMembers.organizationId, video.orgId),
			),
		)
		.limit(1);
	if (!member) throw new Error("User is not in this organization");

	await db().insert(videoShares).ignore().values({
		videoId,
		userId,
		sharedByUserId: user.id,
		source: "manual",
	});
	revalidatePath(`/s/${videoId}`);
	return { success: true };
}

export async function removeVideoShare({
	videoId,
	userId,
}: {
	videoId: Video.VideoId;
	userId: User.UserId;
}): Promise<{ success: true }> {
	const { video } = await requireVideoShareManager(videoId);
	if (userId === video.ownerId) {
		throw new Error("The video owner cannot be removed");
	}
	await db()
		.delete(videoShares)
		.where(
			and(eq(videoShares.videoId, videoId), eq(videoShares.userId, userId)),
		);
	revalidatePath(`/s/${videoId}`);
	return { success: true };
}

export async function getVideoShareSummary({
	videoId,
}: {
	videoId: Video.VideoId;
}): Promise<{ people: number }> {
	await requireVideoShareManager(videoId);
	const shares = await db()
		.select({ userId: videoShares.userId })
		.from(videoShares)
		.where(eq(videoShares.videoId, videoId));
	const extra = new Set(shares.map((row) => row.userId));
	return { people: 1 + extra.size };
}
