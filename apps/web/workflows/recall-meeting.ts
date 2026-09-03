import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { meetingBots, videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import { startAiGeneration } from "@/lib/generate-ai";
import { queueVideoTranscription } from "@/lib/queue-video-transcription";
import { importMeetingChatComments } from "@/lib/recall/chat-comments";
import { RecallApiError } from "@/lib/recall/client";
import { getDefaultRecallClient } from "@/lib/recall/default-client";
import {
	type RecallTranscriptPart,
	recallTranscriptToVtt,
} from "@/lib/recall/transcript";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

const PRESIGNED_PUT_EXPIRES_SECONDS = 3 * 60 * 60;

function sharedSubCode(meetingBotId: string): string {
	return `shared:${meetingBotId}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function meetingTitle(title: string | null, date: Date): string {
	if (title?.trim()) return title.trim();
	const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
		month: "long",
	})} ${date.getFullYear()}`;
	return `Meeting - ${formattedDate}`;
}

async function applyCapTranscriptionFallback(
	meetingBotId: string,
	videoId: Video.VideoId | null,
): Promise<void> {
	if (videoId) {
		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));
		await queueVideoTranscription(videoId);
	}
	await db()
		.update(meetingBots)
		.set({
			status: "transcribing",
			statusSubCode: "cap_fallback",
		})
		.where(eq(meetingBots.id, meetingBotId));
}

async function completeSharedRows(
	meetingBotId: string,
	videoId: Video.VideoId | null,
	status: "complete" | "failed",
	message?: string,
): Promise<void> {
	await db()
		.update(meetingBots)
		.set({
			status,
			videoId,
			...(message ? { errorMessage: message } : {}),
		})
		.where(eq(meetingBots.statusSubCode, sharedSubCode(meetingBotId)));
}

async function claimImport({
	meetingBotId,
	recordingId,
}: {
	meetingBotId: string;
	recordingId: string;
}): Promise<boolean> {
	"use step";

	const [row] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);
	if (!row) {
		throw new FatalError("Meeting bot not found");
	}
	if (
		row.status === "importing" ||
		row.status === "transcribing" ||
		row.status === "complete"
	) {
		return false;
	}

	await db()
		.update(meetingBots)
		.set({
			status: "importing",
			recallRecordingId: recordingId,
			errorMessage: null,
		})
		.where(eq(meetingBots.id, meetingBotId));
	return true;
}

async function createVideoRow(meetingBotId: string): Promise<{
	videoId: Video.VideoId;
	ownerId: typeof meetingBots.$inferSelect.ownerId;
	rawFileKey: string;
	bucketId: string | null;
}> {
	"use step";

	const [row] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);
	if (!row) {
		throw new FatalError("Meeting bot not found");
	}

	if (row.videoId) {
		const [existing] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, row.videoId))
			.limit(1);
		if (existing) {
			const [upload] = await db()
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, row.videoId))
				.limit(1);
			const rawFileKey =
				upload?.rawFileKey ?? `${row.ownerId}/${row.videoId}/raw-upload.mp4`;
			if (!upload) {
				await db().insert(videoUploads).values({
					videoId: row.videoId,
					mode: "singlepart",
					phase: "uploading",
					processingProgress: 0,
					rawFileKey,
				});
			}
			return {
				videoId: row.videoId,
				ownerId: row.ownerId,
				rawFileKey,
				bucketId: existing.bucket,
			};
		}
	}

	const videoId = row.videoId ?? Video.VideoId.make(nanoId());
	const rawFileKey = `${row.ownerId}/${videoId}/raw-upload.mp4`;
	const videoTitle = meetingTitle(row.title, row.joinAt);

	if (!row.videoId) {
		await db()
			.update(meetingBots)
			.set({ videoId })
			.where(eq(meetingBots.id, meetingBotId));
	}

	const uploadResult = await Storage.createUploadTargetForUser(
		row.ownerId,
		rawFileKey,
		{
			contentType: "video/mp4",
			videoTitle,
			method: "put",
			fields: {
				"x-amz-meta-userid": row.ownerId,
			},
		},
		row.orgId,
	).pipe(runWorkflowPromise);

	const [existingVideo] = await db()
		.select({ id: videos.id })
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!existingVideo) {
		await db()
			.insert(videos)
			.values({
				id: videoId,
				name: videoTitle,
				ownerId: row.ownerId,
				orgId: row.orgId,
				source: { type: "webMP4" as const },
				bucket: Option.getOrNull(uploadResult.bucketId),
				storageIntegrationId: Option.getOrNull(
					uploadResult.storageIntegrationId,
				),
				public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
				transcriptionStatus: "PROCESSING",
			});
	}

	const [existingUpload] = await db()
		.select({ videoId: videoUploads.videoId })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId))
		.limit(1);
	if (!existingUpload) {
		await db().insert(videoUploads).values({
			videoId,
			mode: "singlepart",
			phase: "uploading",
			processingProgress: 0,
			rawFileKey,
		});
	}

	return {
		videoId,
		ownerId: row.ownerId,
		rawFileKey,
		bucketId: Option.getOrNull(uploadResult.bucketId),
	};
}

async function copyRecordingToStorage({
	recordingId,
	videoId,
	rawFileKey,
}: {
	recordingId: string;
	videoId: Video.VideoId;
	rawFileKey: string;
}): Promise<void> {
	"use step";

	const client = getDefaultRecallClient();
	const recording = await client.getRecording(recordingId);
	const downloadUrl = recording.media_shortcuts.video_mixed?.data?.download_url;
	if (!downloadUrl) {
		throw new FatalError("Recording download URL is missing");
	}

	const download = await fetch(downloadUrl);
	if (!download.ok) {
		throw new FatalError(`Recording download failed (${download.status})`);
	}

	const contentType = download.headers.get("content-type") ?? "";
	if (
		contentType.includes("text/html") ||
		contentType.includes("application/json")
	) {
		throw new FatalError(
			`Recording download returned non-video content (${contentType.split(";")[0]})`,
		);
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const putUrl = await bucket
		.getInternalPresignedPutUrl(
			rawFileKey,
			{ ContentType: "video/mp4" },
			{ expiresIn: PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);

	const contentLength = download.headers.get("content-length");
	let upload: Response;
	if (contentLength && download.body) {
		upload = await fetch(putUrl, {
			method: "PUT",
			headers: {
				"Content-Type": "video/mp4",
				"Content-Length": contentLength,
			},
			body: download.body,
			duplex: "half",
		} as RequestInit);
	} else {
		const buffer = Buffer.from(await download.arrayBuffer());
		upload = await fetch(putUrl, {
			method: "PUT",
			headers: {
				"Content-Type": "video/mp4",
				"Content-Length": String(buffer.length),
			},
			body: buffer,
		});
	}

	if (!upload.ok) {
		throw new FatalError(`Recording upload failed (${upload.status})`);
	}
}

async function startProcessing({
	videoId,
	userId,
	rawFileKey,
	bucketId,
}: {
	videoId: Video.VideoId;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
}): Promise<void> {
	"use step";

	await startVideoProcessingWorkflow({
		videoId,
		userId,
		rawFileKey,
		bucketId,
		processingMessage: "Processing meeting recording...",
		startFailureMessage: "Meeting recording processing could not start.",
	});
}

async function createTranscript({
	meetingBotId,
	recordingId,
	videoId,
}: {
	meetingBotId: string;
	recordingId: string;
	videoId: Video.VideoId;
}): Promise<void> {
	"use step";

	const [row] = await db()
		.select({
			recallTranscriptId: meetingBots.recallTranscriptId,
		})
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);
	if (row?.recallTranscriptId) {
		await db()
			.update(meetingBots)
			.set({ status: "transcribing" })
			.where(eq(meetingBots.id, meetingBotId));
		return;
	}

	const client = getDefaultRecallClient();
	try {
		const transcript = await client.createAsyncTranscript(recordingId);
		await db()
			.update(meetingBots)
			.set({
				recallTranscriptId: transcript.id,
				status: "transcribing",
			})
			.where(eq(meetingBots.id, meetingBotId));
	} catch (error) {
		console.error("[recall] create transcript failed", {
			meetingBotId,
			recordingId,
			status: error instanceof RecallApiError ? error.status : undefined,
		});
		await applyCapTranscriptionFallback(meetingBotId, videoId);
	}
}

async function importChatComments(meetingBotId: string): Promise<void> {
	"use step";

	await importMeetingChatComments({ meetingBotId });
}

async function markImportFailed(
	meetingBotId: string,
	error: unknown,
): Promise<void> {
	"use step";

	const message = errorMessage(error);
	const [row] = await db()
		.select({ videoId: meetingBots.videoId })
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);

	await db()
		.update(meetingBots)
		.set({
			status: "failed",
			errorMessage: message,
		})
		.where(eq(meetingBots.id, meetingBotId));

	if (row?.videoId) {
		await db()
			.update(videoUploads)
			.set({
				phase: "error",
				processingProgress: 0,
				processingMessage: "Meeting recording import failed",
				processingError: message,
				updatedAt: new Date(),
			})
			.where(eq(videoUploads.videoId, row.videoId));
	}

	await completeSharedRows(
		meetingBotId,
		row?.videoId ?? null,
		"failed",
		message,
	);
}

export async function importRecallRecordingWorkflow({
	meetingBotId,
	recordingId,
}: {
	meetingBotId: string;
	recordingId: string;
}): Promise<void> {
	"use workflow";

	try {
		const claimed = await claimImport({ meetingBotId, recordingId });
		if (!claimed) return;

		const video = await createVideoRow(meetingBotId);
		await copyRecordingToStorage({
			recordingId,
			videoId: video.videoId,
			rawFileKey: video.rawFileKey,
		});
		await startProcessing({
			videoId: video.videoId,
			userId: video.ownerId,
			rawFileKey: video.rawFileKey,
			bucketId: video.bucketId,
		});
		await createTranscript({
			meetingBotId,
			recordingId,
			videoId: video.videoId,
		});
		try {
			await importChatComments(meetingBotId);
		} catch (error) {
			console.error("[recall] chat import failed", {
				meetingBotId,
				status: error instanceof RecallApiError ? error.status : undefined,
			});
		}
	} catch (error) {
		await markImportFailed(meetingBotId, error);
		throw error instanceof FatalError
			? error
			: new FatalError(errorMessage(error));
	}
}

async function writeRecallTranscript({
	meetingBotId,
	transcriptId,
}: {
	meetingBotId: string;
	transcriptId: string;
}): Promise<void> {
	"use step";

	const [row] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);
	if (!row) {
		throw new FatalError("Meeting bot not found");
	}
	if (row.status === "complete") return;
	if (!row.videoId) {
		throw new FatalError("Meeting bot has no video");
	}

	const client = getDefaultRecallClient();
	const transcript = await client.getTranscript(transcriptId);
	const downloadUrl = transcript.data?.download_url;
	if (!downloadUrl || transcript.status.code === "failed") {
		await applyCapTranscriptionFallback(meetingBotId, row.videoId);
		return;
	}

	const parts = await client.downloadJson<RecallTranscriptPart[]>(downloadUrl);
	const vtt = recallTranscriptToVtt(Array.isArray(parts) ? parts : []);

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, row.videoId))
		.limit(1);
	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	await bucket
		.putObject(`${row.ownerId}/${row.videoId}/transcription.vtt`, vtt, {
			contentType: "text/vtt",
		})
		.pipe(runWorkflowPromise);

	await db()
		.update(videos)
		.set({ transcriptionStatus: "COMPLETE" })
		.where(eq(videos.id, row.videoId));
	await db()
		.update(meetingBots)
		.set({
			status: "complete",
			recallTranscriptId: transcriptId,
			errorMessage: null,
		})
		.where(eq(meetingBots.id, meetingBotId));
	await completeSharedRows(meetingBotId, row.videoId, "complete");

	await startAiGeneration(row.videoId, row.ownerId);
}

async function fallbackToCapTranscription(meetingBotId: string): Promise<void> {
	"use step";

	const [row] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);
	if (!row) {
		throw new FatalError("Meeting bot not found");
	}
	if (row.status === "complete") return;
	if (row.status === "transcribing" && row.statusSubCode === "cap_fallback") {
		return;
	}

	await applyCapTranscriptionFallback(meetingBotId, row.videoId);
}

export async function completeRecallTranscriptWorkflow({
	meetingBotId,
	transcriptId,
}: {
	meetingBotId: string;
	transcriptId: string;
}): Promise<void> {
	"use workflow";

	try {
		await writeRecallTranscript({ meetingBotId, transcriptId });
	} catch (error) {
		await fallbackToCapTranscription(meetingBotId);
		if (!(error instanceof FatalError)) {
			throw new FatalError(errorMessage(error));
		}
	}
}

export async function failRecallTranscriptWorkflow({
	meetingBotId,
}: {
	meetingBotId: string;
}): Promise<void> {
	"use workflow";

	await fallbackToCapTranscription(meetingBotId);
}
