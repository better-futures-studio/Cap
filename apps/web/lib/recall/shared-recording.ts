import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { meetingBots, sharedVideos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";

export function sharedMeetingSubCode(meetingBotId: string): string {
	return `shared:${meetingBotId}`;
}

export async function sharePrimaryRecordingWithOrganization({
	meetingBotId,
	videoId,
}: {
	meetingBotId: string;
	videoId: Video.VideoId;
}): Promise<void> {
	try {
		const sharedRows = await db()
			.select({ id: meetingBots.id })
			.from(meetingBots)
			.where(eq(meetingBots.statusSubCode, sharedMeetingSubCode(meetingBotId)))
			.limit(1);
		if (sharedRows.length === 0) return;

		const [primary] = await db()
			.select({
				ownerId: meetingBots.ownerId,
				orgId: meetingBots.orgId,
			})
			.from(meetingBots)
			.where(eq(meetingBots.id, meetingBotId))
			.limit(1);
		if (!primary) return;

		const [existingShare] = await db()
			.select({ id: sharedVideos.id })
			.from(sharedVideos)
			.where(
				and(
					eq(sharedVideos.videoId, videoId),
					eq(sharedVideos.organizationId, primary.orgId),
				),
			)
			.limit(1);
		if (existingShare) return;

		await db().insert(sharedVideos).values({
			id: nanoId(),
			videoId,
			organizationId: primary.orgId,
			sharedByUserId: primary.ownerId,
		});
	} catch (error) {
		console.error("[recall] share recording with organization failed", {
			meetingBotId,
			videoId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}
