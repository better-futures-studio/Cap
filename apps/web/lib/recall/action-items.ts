import { db } from "@cap/database";
import { comments, videos } from "@cap/database/schema";
import type { MeetingActionItem, VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { parseMeetingActionItems } from "./parse-action-items";

export type { MeetingActionItem };
export {
	mergeMeetingActionItems,
	parseCapturedActionItem,
	parseMeetingActionItems,
} from "./parse-action-items";

export async function getMeetingActionItems(
	videoId: string,
): Promise<MeetingActionItem[]> {
	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	return parseMeetingActionItems(
		(video?.metadata as VideoMetadata | undefined)?.meetingActionItems,
	);
}

export async function loadCapturedActionItemComments(
	videoId: string,
): Promise<{ content: string }[]> {
	return db()
		.select({ content: comments.content })
		.from(comments)
		.where(eq(comments.videoId, videoId as Video.VideoId));
}
