import { db } from "@cap/database";
import { meetingBots, videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { queueVideoTranscription } from "@/lib/queue-video-transcription";
import { RecallApiError, type RecallClient } from "./client";
import { getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";
import { maybeDeleteImportedRecallMedia } from "./media-retention";
import {
	reusableRecordingTranscript,
	shouldStartTranscriptCompletion,
} from "./transcript-reuse";
import {
	listMeetingVocabularyTerms,
	toRecallTranscriptVocabulary,
} from "./vocabulary";

export async function applyCapTranscriptionFallback(
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
	if (videoId) await maybeDeleteImportedRecallMedia(meetingBotId);
}

export async function createMeetingTranscript(
	{
		meetingBotId,
		recordingId,
		videoId,
	}: {
		meetingBotId: string;
		recordingId: string;
		videoId: Video.VideoId;
	},
	deps: { client?: RecallClient } = {},
): Promise<{ transcriptId: string | null; startCompletion: boolean }> {
	const [row] = await db()
		.select({
			orgId: meetingBots.orgId,
			recallTranscriptId: meetingBots.recallTranscriptId,
			status: meetingBots.status,
		})
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);
	if (
		row?.recallTranscriptId &&
		(row.status === "transcribing" || row.status === "complete")
	) {
		return {
			transcriptId: row.recallTranscriptId,
			startCompletion: false,
		};
	}

	const client = deps.client ?? getDefaultRecallClient();
	try {
		const recording = await client.getRecording(recordingId);
		const existing = reusableRecordingTranscript(recording);
		if (existing) {
			const startCompletion =
				existing.status === "done" &&
				shouldStartTranscriptCompletion(
					{
						recallTranscriptId: row?.recallTranscriptId ?? null,
						status: row?.status ?? "importing",
					},
					existing.id,
				);
			await db()
				.update(meetingBots)
				.set({
					recallTranscriptId: existing.id,
					...(startCompletion ? { status: "transcribing" as const } : {}),
				})
				.where(eq(meetingBots.id, meetingBotId));
			return { transcriptId: existing.id, startCompletion };
		}

		let keyTerms: string[] = [];
		let spelling: { find: string[]; replace: string }[] = [];
		if (row) {
			try {
				const vocabulary = toRecallTranscriptVocabulary(
					await listMeetingVocabularyTerms(row.orgId),
				);
				keyTerms = vocabulary.keyTerms;
				spelling = vocabulary.spelling;
			} catch (error) {
				console.error("[recall] load vocabulary failed", {
					meetingBotId,
					error: error instanceof Error ? error.message : "unknown",
				});
			}
		}
		const transcript = await client.createAsyncTranscript(recordingId, {
			provider: getRecallConfig()?.transcriptionProvider,
			keyTerms,
			spelling,
		});
		await db()
			.update(meetingBots)
			.set({
				recallTranscriptId: transcript.id,
			})
			.where(eq(meetingBots.id, meetingBotId));
		return { transcriptId: transcript.id, startCompletion: false };
	} catch (error) {
		console.error("[recall] create transcript failed", {
			meetingBotId,
			recordingId,
			status: error instanceof RecallApiError ? error.status : undefined,
		});
		await applyCapTranscriptionFallback(meetingBotId, videoId);
		return { transcriptId: null, startCompletion: false };
	}
}
