import { db } from "@cap/database";
import { organizations, videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	type AiGenerationLanguage,
	parseSummaryLanguage,
	type Video,
} from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { FatalError } from "workflow";
import {
	deleteGeminiFile,
	describeVideoWithGemini,
	isVideoUnderstandingEnabled,
	uploadVideoToGemini,
	waitForGeminiFile,
} from "@/lib/ai/gemini-video";
import { enqueueVideoStorageNameSync } from "@/lib/sync-video-storage-names";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import { shouldReplaceVideoTitle } from "@/workflows/generate-ai";

interface DescribeSilentVideoPayload {
	videoId: string;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	metadata: VideoMetadata;
	summaryLanguage: AiGenerationLanguage;
}

interface ProcessedVideoSource {
	sourceUrl: string;
	sizeBytes: number;
	displayName: string;
	durationSeconds: number;
}

interface DescribeResult {
	title?: string;
	summary?: string;
	chapters?: { title: string; start: number }[];
}

const LEGACY_AI_TITLE_FALLBACK = "Generated Title";
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

export async function describeSilentVideoWorkflow(
	payload: DescribeSilentVideoPayload,
) {
	"use workflow";

	const { videoId } = payload;

	let videoData: VideoData;
	try {
		videoData = await validateAndSetProcessing(videoId);
	} catch (error) {
		await markError(videoId);
		throw error;
	}

	let geminiFileName: string | undefined;
	try {
		const source = await resolveProcessedVideo(videoId, videoData.video);
		const uploaded = await uploadToGemini(source);
		geminiFileName = uploaded.name;
		await waitUntilActive(uploaded.name);
		const result = await describeWithGemini(
			uploaded.uri,
			source.durationSeconds,
			videoData.summaryLanguage,
		);
		await saveResults(videoId, videoData, result);
	} catch (error) {
		await markError(videoId);
		throw error;
	} finally {
		if (geminiFileName) {
			await deleteUploadedFile(geminiFileName);
		}
	}

	return { success: true, message: "Video description completed successfully" };
}

async function validateAndSetProcessing(videoId: string): Promise<VideoData> {
	"use step";

	if (!isVideoUnderstandingEnabled()) {
		throw new FatalError("Video understanding is not configured");
	}

	const query = await db()
		.select({ video: videos, orgSettings: organizations.settings })
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0 || !query[0]?.video) {
		throw new FatalError("Video does not exist");
	}

	const { video } = query[0];
	const metadata = (video.metadata as VideoMetadata) || {};

	if (video.isScreenshot) {
		throw new FatalError("Screenshot does not need description");
	}

	if (
		video.duration != null &&
		video.duration < MIN_DESCRIBE_DURATION_SECONDS
	) {
		throw new FatalError("Video is too short to describe");
	}

	if (
		metadata.summary &&
		metadata.summary !== LEGACY_AI_SUMMARY_FALLBACK &&
		metadata.chapters
	) {
		throw new FatalError("AI metadata already generated");
	}

	let processingMetadata = sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'PROCESSING')`;
	for (const [metadataPath, fallback] of [
		["$.aiTitle", LEGACY_AI_TITLE_FALLBACK],
		["$.summary", LEGACY_AI_SUMMARY_FALLBACK],
	] as const) {
		processingMetadata = sql`IF(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, ${metadataPath})) = ${fallback}, JSON_REMOVE(${processingMetadata}, ${metadataPath}), ${processingMetadata})`;
	}

	await db()
		.update(videos)
		.set({
			metadata: processingMetadata,
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video,
		metadata,
		summaryLanguage: parseSummaryLanguage(
			query[0]?.orgSettings?.summaryLanguage,
		),
	};
}

async function resolveProcessedVideo(
	videoId: string,
	video: typeof videos.$inferSelect,
): Promise<ProcessedVideoSource> {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	const upload = await db()
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId))
		.limit(1);

	const candidateKeys = [
		`${video.ownerId}/${videoId}/result.mp4`,
		upload[0]?.rawFileKey,
	].filter(
		(value, index, values): value is string =>
			Boolean(value) && values.indexOf(value) === index,
	);

	for (const key of candidateKeys) {
		try {
			const head = await bucket.headObject(key).pipe(runWorkflowPromise);
			const sizeBytes = head.ContentLength ?? 0;
			if (sizeBytes <= 0) continue;

			const sourceUrl = await bucket
				.getInternalSignedObjectUrl(key)
				.pipe(runWorkflowPromise);

			return {
				sourceUrl,
				sizeBytes,
				displayName: `${video.ownerId}-${videoId}.mp4`,
				durationSeconds: Math.max(0, video.duration ?? 0),
			};
		} catch {}
	}

	throw new FatalError("Processed video file not accessible");
}

async function uploadToGemini(
	source: ProcessedVideoSource,
): Promise<{ name: string; uri: string }> {
	"use step";

	return uploadVideoToGemini({
		sourceUrl: source.sourceUrl,
		sizeBytes: source.sizeBytes,
		displayName: source.displayName,
	});
}

async function waitUntilActive(name: string): Promise<void> {
	"use step";

	await waitForGeminiFile(name);
}

async function describeWithGemini(
	fileUri: string,
	durationSeconds: number,
	language: AiGenerationLanguage,
): Promise<DescribeResult> {
	"use step";

	const result = await describeVideoWithGemini({
		fileUri,
		durationSeconds,
		language,
	});

	return {
		title: result.title,
		summary: result.summary,
		chapters: result.chapters,
	};
}

async function deleteUploadedFile(name: string): Promise<void> {
	"use step";

	await deleteGeminiFile(name);
}

async function markError(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'ERROR')`,
		})
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				sql`NOT (
					COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')), '') = 'COMPLETE'
					AND JSON_EXTRACT(${videos.metadata}, '$.summary') IS NOT NULL
					AND JSON_EXTRACT(${videos.metadata}, '$.chapters') IS NOT NULL
				)`,
			),
		);
}

async function saveResults(
	videoId: string,
	videoData: VideoData,
	result: DescribeResult,
): Promise<void> {
	"use step";

	const { video, metadata } = videoData;
	const generatedTitle = result.title?.trim();
	const currentVideo = await getCurrentVideo(videoId);
	const currentMetadata = currentVideo
		? (currentVideo.metadata as VideoMetadata) || {}
		: metadata;
	const currentTitle = currentVideo?.name ?? video.name;

	let metadataUpdate = sql`COALESCE(${videos.metadata}, JSON_OBJECT())`;
	if (generatedTitle) {
		metadataUpdate = sql`JSON_SET(${metadataUpdate}, '$.aiTitle', ${generatedTitle})`;
	}
	if (result.summary) {
		metadataUpdate = sql`JSON_SET(${metadataUpdate}, '$.summary', ${result.summary})`;
	}
	if (result.chapters) {
		metadataUpdate = sql`JSON_SET(${metadataUpdate}, '$.chapters', CAST(${JSON.stringify(result.chapters)} AS JSON))`;
	}
	metadataUpdate = sql`JSON_SET(${metadataUpdate}, '$.aiGenerationStatus', 'COMPLETE', '$.aiSource', 'video')`;

	await db()
		.update(videos)
		.set({ metadata: metadataUpdate })
		.where(eq(videos.id, videoId as Video.VideoId));

	if (
		generatedTitle &&
		shouldReplaceVideoTitle({
			currentTitle,
			previousAiTitle: currentMetadata.aiTitle,
			nextAiTitle: generatedTitle,
			sourceName: currentMetadata.sourceName,
			titleManuallyEdited: currentMetadata.titleManuallyEdited,
		})
	) {
		const titleUpdate = await db()
			.update(videos)
			.set({ name: generatedTitle })
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					eq(videos.name, currentTitle),
					sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.titleManuallyEdited')), 'false') <> 'true'`,
				),
			);
		if (getAffectedRows(titleUpdate) > 0) {
			await enqueueVideoStorageNameSync(videoId as Video.VideoId);
		}
	}
}

async function getCurrentVideo(
	videoId: string,
): Promise<typeof videos.$inferSelect | null> {
	const [currentVideo] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	return currentVideo ?? null;
}
