import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { start } from "workflow/api";
import { isVideoUnderstandingEnabled } from "@/lib/ai/gemini-video";
import { describeSilentVideoWorkflow } from "@/workflows/describe-video";

type DescribeVideoResult = {
	success: boolean;
	message: string;
};

const LEGACY_AI_SUMMARY_FALLBACK =
	"The AI was unable to generate a proper summary for this content.";

const MIN_DESCRIBE_DURATION_SECONDS = 5;

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export async function startDescribeSilentVideo(
	videoId: Video.VideoId,
	userId: string,
): Promise<DescribeVideoResult> {
	if (!isVideoUnderstandingEnabled()) {
		return {
			success: true,
			message: "Video understanding is not configured",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video does not exist" };
	}

	const { video } = query[0];
	if (video.isScreenshot) {
		return { success: true, message: "Screenshot does not need description" };
	}
	if (
		video.duration != null &&
		video.duration < MIN_DESCRIBE_DURATION_SECONDS
	) {
		return { success: true, message: "Video is too short to describe" };
	}

	const metadata = (video.metadata as VideoMetadata) || {};

	if (
		metadata.aiGenerationStatus === "PROCESSING" ||
		metadata.aiGenerationStatus === "QUEUED"
	) {
		return {
			success: true,
			message: "Video description already in progress",
		};
	}

	if (
		metadata.aiGenerationStatus === "COMPLETE" &&
		metadata.summary &&
		metadata.summary !== LEGACY_AI_SUMMARY_FALLBACK &&
		metadata.chapters
	) {
		return {
			success: true,
			message: "AI metadata already generated",
		};
	}

	try {
		const transitionResult = await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "QUEUED",
				},
			})
			.where(
				and(eq(videos.id, videoId), eq(videos.updatedAt, video.updatedAt)),
			);

		if (getAffectedRows(transitionResult) === 0) {
			return {
				success: true,
				message: "Video description already in progress",
			};
		}

		await start(describeSilentVideoWorkflow, [{ videoId }]);

		return {
			success: true,
			message: "Video description workflow started",
		};
	} catch {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'ERROR')`,
			})
			.where(
				and(
					eq(videos.id, videoId),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) = 'QUEUED'`,
				),
			);

		return {
			success: false,
			message: "Failed to start video description workflow",
		};
	}
}
