"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { meetingBots, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { provideOptionalAuth, Storage, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import { headers } from "next/headers";
import { isAiConfigured } from "@/lib/ai/provider";
import { runWithAiProviders } from "@/lib/ai/run";
import {
	type AskVideoMessage,
	type AskVideoResult,
	askVideoSystemPrompt,
	formatAskTimestamp,
	formatAskTranscript,
	normalizeAskVideoHistory,
	parseAskVideoReferences,
} from "@/lib/ask-video";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import {
	type LiveChatEntry,
	readLiveTranscript,
} from "@/lib/recall/live-transcript";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { loadOrganizationSummaryLanguage } from "@/lib/summary-language";
import { decodeStorageVideo } from "@/lib/video-storage";

export type {
	AskVideoMessage,
	AskVideoReference,
	AskVideoResult,
} from "@/lib/ask-video";

const ASK_WINDOW_MS = 10 * 60 * 1000;
const ASK_MAX_REQUESTS = 30;
const askRequestLog = new Map<string, number[]>();

function isLocallyRateLimited(key: string): boolean {
	const now = Date.now();
	const recent = (askRequestLog.get(key) ?? []).filter(
		(timestamp) => now - timestamp < ASK_WINDOW_MS,
	);
	if (recent.length >= ASK_MAX_REQUESTS) {
		askRequestLog.set(key, recent);
		return true;
	}
	recent.push(now);
	askRequestLog.set(key, recent);
	return false;
}

async function rateLimitKey(): Promise<string> {
	const user = await getCurrentUser();
	if (user?.id) return user.id;
	const headersList = await headers();
	return (
		headersList.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		headersList.get("x-real-ip") ||
		"anonymous"
	);
}

async function loadViewableVideo(videoId: string) {
	const id = videoId as Video.VideoId;
	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		return yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, id)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(id)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) return null;
	return exit.value[0] ?? null;
}

async function loadTranscriptVtt(
	video: typeof videos.$inferSelect,
	videoId: string,
): Promise<string | null> {
	const vtt = await Effect.gen(function* () {
		const [bucket] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
		);
		return yield* bucket.getObject(
			`${video.ownerId}/${videoId}/transcription.vtt`,
		);
	}).pipe(runPromise);

	if (Option.isNone(vtt) || !vtt.value.trim()) return null;
	return vtt.value;
}

function formatMeetingChat(entries: LiveChatEntry[]): string {
	return entries
		.map((entry) =>
			entry.fromBot
				? `[chat] Notetaker: ${entry.text}`
				: `[chat] ${entry.speaker}: ${entry.text}`,
		)
		.join("\n");
}

async function loadMeetingChat(videoId: string): Promise<string | null> {
	const [meetingBot] = await db()
		.select({ id: meetingBots.id })
		.from(meetingBots)
		.where(eq(meetingBots.videoId, videoId as Video.VideoId))
		.limit(1);
	if (!meetingBot) return null;
	try {
		const document = await readLiveTranscript(meetingBot.id);
		const chat = document?.chat ?? [];
		if (chat.length === 0) return null;
		return formatMeetingChat(chat);
	} catch {
		return null;
	}
}

function formatMaterial(input: {
	summary?: string;
	chapters?: { title: string; start: number }[];
	actionItems?: VideoMetadata["meetingActionItems"];
	chat: string | null;
	transcript: string;
}): string {
	const sections: string[] = [];
	if (input.summary?.trim()) {
		sections.push(`Summary\n${input.summary.trim()}`);
	}
	if (input.chapters && input.chapters.length > 0) {
		sections.push(
			`Chapters\n${input.chapters
				.map(
					(chapter) =>
						`- [${formatAskTimestamp(chapter.start)}] ${chapter.title}`,
				)
				.join("\n")}`,
		);
	}
	if (input.actionItems && input.actionItems.length > 0) {
		sections.push(
			`Action items\n${input.actionItems
				.map((item) => {
					const owner = item.owner ? `${item.owner}: ` : "";
					const due = item.due ? ` (due ${item.due})` : "";
					return `- ${owner}${item.text}${due}`;
				})
				.join("\n")}`,
		);
	}
	if (input.chat) {
		sections.push(`Meeting chat\n${input.chat}`);
	}
	sections.push(`Transcript\n${input.transcript}`);
	return sections.join("\n\n");
}

async function answerAskVideo(
	system: string,
	messages: AskVideoMessage[],
): Promise<string> {
	return runWithAiProviders("chat", async (selection) => {
		const result = await generateText({
			model: selection.model(),
			system,
			messages,
			maxOutputTokens: selection.defaultMaxOutputTokens,
		});
		return result.text;
	});
}

export async function getAskVideoAvailability(input: {
	videoId: string;
}): Promise<{
	available: boolean;
	reason?: "no-transcript" | "ai-disabled" | "forbidden";
}> {
	const video = await loadViewableVideo(input.videoId);
	if (!video) return { available: false, reason: "forbidden" };
	if (!isAiConfigured("chat"))
		return { available: false, reason: "ai-disabled" };
	if (video.transcriptionStatus !== "COMPLETE") {
		return { available: false, reason: "no-transcript" };
	}
	const vtt = await loadTranscriptVtt(video, input.videoId);
	if (!vtt) return { available: false, reason: "no-transcript" };
	return { available: true };
}

export async function askVideo(input: {
	videoId: string;
	question: string;
	history?: AskVideoMessage[];
}): Promise<AskVideoResult> {
	const question = input.question.trim();
	if (!question) throw new Error("Question is required");

	const video = await loadViewableVideo(input.videoId);
	if (!video) throw new Error("Forbidden");
	if (!isAiConfigured("chat")) throw new Error("AI is not configured");
	if (video.transcriptionStatus !== "COMPLETE") {
		throw new Error("Transcript is not ready");
	}

	const key = await rateLimitKey();
	if (
		isLocallyRateLimited(key) ||
		(await isRateLimited(RATE_LIMIT_IDS.ASK_VIDEO, { key }))
	) {
		throw new Error("Too many questions. Please try again in a few minutes.");
	}

	const vtt = await loadTranscriptVtt(video, input.videoId);
	if (!vtt) throw new Error("Transcript is not ready");

	const metadata = (video.metadata as VideoMetadata) || {};
	const transcript = formatAskTranscript(vtt);
	const chat = await loadMeetingChat(input.videoId);
	const material = formatMaterial({
		summary: metadata.summary,
		chapters: metadata.chapters,
		actionItems: metadata.meetingActionItems,
		chat,
		transcript: transcript.text,
	});
	const history = normalizeAskVideoHistory(input.history);
	const summaryLanguage = await loadOrganizationSummaryLanguage(video.orgId);
	const answer = (
		await answerAskVideo(
			askVideoSystemPrompt(transcript.trimmed, summaryLanguage),
			[
				{ role: "user", content: material },
				...history,
				{ role: "user", content: question },
			],
		)
	).trim();

	return {
		answer,
		references: parseAskVideoReferences(answer),
	};
}
