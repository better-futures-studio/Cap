import { db } from "@cap/database";
import {
	meetingBots,
	organizationMembers,
	organizations,
	sharedVideos,
	spaceMembers,
	spaceVideos,
	videoShares,
	videos,
} from "@cap/database/schema";
import { isEmailAllowedByRestriction } from "@cap/utils";
import { VideosPolicy } from "@cap/web-backend";
import { CurrentUser, Policy, type Video } from "@cap/web-domain";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import { meetingBotIdsAccessibleToUser } from "@/lib/recall/visibility";
import * as EffectRuntime from "@/lib/server";
import type { McpPrincipal } from "./mcp-auth";

export function toCurrentUser(principal: McpPrincipal): CurrentUser["Type"] {
	return {
		id: principal.id,
		email: principal.email,
		activeOrganizationId: principal.activeOrganizationId,
		iconUrlOrKey: Option.none(),
	};
}

export async function userCanViewVideo(
	principal: McpPrincipal,
	videoId: string,
): Promise<boolean> {
	const id = videoId as Video.VideoId;
	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		const rows = yield* Effect.promise(() =>
			db().select({ id: videos.id }).from(videos).where(eq(videos.id, id)),
		);
		if (!rows[0]) return false;
		return yield* Effect.succeed(true).pipe(
			Policy.withPublicPolicy(videosPolicy.canView(id)),
		);
	}).pipe(
		Effect.provideService(CurrentUser, toCurrentUser(principal)),
		EffectRuntime.runPromiseExit,
	);
	return Exit.isSuccess(exit) && exit.value === true;
}

export async function loadViewableVideo(
	principal: McpPrincipal,
	videoId: string,
) {
	const id = videoId as Video.VideoId;
	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		return yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, id)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(id)));
	}).pipe(
		Effect.provideService(CurrentUser, toCurrentUser(principal)),
		EffectRuntime.runPromiseExit,
	);
	if (Exit.isFailure(exit)) return null;
	return exit.value[0] ?? null;
}

export async function listAccessibleVideoIds(
	principal: McpPrincipal,
): Promise<Set<string>> {
	const userId = principal.id;
	const [owned, shares, orgShares, spaceShared, publicRows] = await Promise.all(
		[
			db()
				.select({ id: videos.id })
				.from(videos)
				.where(eq(videos.ownerId, userId)),
			db()
				.select({ id: videoShares.videoId })
				.from(videoShares)
				.where(eq(videoShares.userId, userId)),
			db()
				.select({ id: sharedVideos.videoId })
				.from(sharedVideos)
				.innerJoin(
					organizationMembers,
					eq(organizationMembers.organizationId, sharedVideos.organizationId),
				)
				.where(eq(organizationMembers.userId, userId)),
			db()
				.select({ id: spaceVideos.videoId })
				.from(spaceVideos)
				.innerJoin(spaceMembers, eq(spaceMembers.spaceId, spaceVideos.spaceId))
				.where(eq(spaceMembers.userId, userId)),
			db()
				.select({
					id: videos.id,
					password: videos.password,
					orgId: videos.orgId,
					allowedEmailDomain: organizations.allowedEmailDomain,
				})
				.from(videos)
				.innerJoin(organizations, eq(organizations.id, videos.orgId))
				.where(and(eq(videos.public, true), isNull(videos.password))),
		],
	);

	const ids = new Set<string>();
	for (const row of owned) ids.add(row.id);
	for (const row of shares) ids.add(row.id);
	for (const row of orgShares) ids.add(row.id);
	for (const row of spaceShared) ids.add(row.id);
	for (const row of publicRows) {
		if (row.password) continue;
		const restriction = row.allowedEmailDomain?.trim() ?? "";
		if (
			restriction.length > 0 &&
			!isEmailAllowedByRestriction(principal.email, restriction)
		) {
			continue;
		}
		ids.add(row.id);
	}

	const bots = await db()
		.select({
			id: meetingBots.id,
			ownerId: meetingBots.ownerId,
			recallBotId: meetingBots.recallBotId,
			videoId: meetingBots.videoId,
			calendarEventId: meetingBots.calendarEventId,
			statusSubCode: meetingBots.statusSubCode,
		})
		.from(meetingBots)
		.where(or(eq(meetingBots.ownerId, userId), isNotNull(meetingBots.videoId)))
		.limit(500);
	const allowedBots = await meetingBotIdsAccessibleToUser({
		bots,
		userId,
	});
	for (const bot of bots) {
		if (bot.videoId && allowedBots.has(bot.id)) ids.add(bot.videoId);
	}

	return ids;
}

export async function filterAccessibleVideoIds(
	principal: McpPrincipal,
	videoIds: string[],
): Promise<Set<string>> {
	if (videoIds.length === 0) return new Set();
	const accessible = await listAccessibleVideoIds(principal);
	return new Set(videoIds.filter((id) => accessible.has(id)));
}

export async function listAccessibleMeetingBotIds(principal: McpPrincipal) {
	const bots = await db()
		.select({
			id: meetingBots.id,
			ownerId: meetingBots.ownerId,
			recallBotId: meetingBots.recallBotId,
			videoId: meetingBots.videoId,
			calendarEventId: meetingBots.calendarEventId,
			statusSubCode: meetingBots.statusSubCode,
		})
		.from(meetingBots)
		.limit(500);
	return meetingBotIdsAccessibleToUser({
		bots,
		userId: principal.id,
	});
}
