import type { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend";
import { generateText } from "ai";
import { Effect, Option } from "effect";
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
import { runPromise } from "@/lib/server";
import { loadOrganizationSummaryLanguage } from "@/lib/summary-language";
import { decodeStorageVideo } from "@/lib/video-storage";
import type { McpPrincipal } from "./mcp-auth";

const ASK_WINDOW_MS = 10 * 60 * 1000;
const ASK_MAX_REQUESTS = 30;
const askRequestLog = new Map<string, number[]>();

function isLocallyRateLimited(key: string) {
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

function formatMeetingChat(entries: LiveChatEntry[]) {
	return entries
		.map((entry) =>
			entry.fromBot
				? `[chat] Notetaker: ${entry.text}`
				: `[chat] ${entry.speaker}: ${entry.text}`,
		)
		.join("\n");
}

async function loadMeetingChat(_videoId: string, meetingBotId: string | null) {
	if (!meetingBotId) return null;
	try {
		const document = await readLiveTranscript(meetingBotId);
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
}) {
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

export async function askRecordingForUser(input: {
	principal: McpPrincipal;
	video: typeof videos.$inferSelect;
	question: string;
	meetingBotId?: string | null;
}): Promise<AskVideoResult> {
	const question = input.question.trim();
	if (!question) throw new Error("Question is required");
	if (!isAiConfigured("chat")) throw new Error("AI is not configured");
	if (input.video.transcriptionStatus !== "COMPLETE") {
		throw new Error("Transcript is not ready");
	}

	const key = input.principal.id;
	if (
		isLocallyRateLimited(key) ||
		(await isRateLimited(RATE_LIMIT_IDS.ASK_VIDEO, { key }))
	) {
		throw new Error("Too many questions. Please try again in a few minutes.");
	}

	const vtt = await loadTranscriptVtt(input.video, input.video.id);
	if (!vtt) throw new Error("Transcript is not ready");

	const metadata = (input.video.metadata as VideoMetadata) || {};
	const transcript = formatAskTranscript(vtt);
	const chat = await loadMeetingChat(
		input.video.id,
		input.meetingBotId ?? null,
	);
	const material = formatMaterial({
		summary: metadata.summary,
		chapters: metadata.chapters,
		actionItems: metadata.meetingActionItems,
		chat,
		transcript: transcript.text,
	});
	const history: AskVideoMessage[] = normalizeAskVideoHistory(undefined);
	const summaryLanguage = await loadOrganizationSummaryLanguage(
		input.video.orgId,
	);
	const answer = (
		await runWithAiProviders("chat", async (selection) => {
			const result = await generateText({
				model: selection.model(),
				system: askVideoSystemPrompt(transcript.trimmed, summaryLanguage),
				messages: [
					{ role: "user", content: material },
					...history,
					{ role: "user", content: question },
				],
				maxOutputTokens: selection.defaultMaxOutputTokens,
			});
			return result.text;
		})
	).trim();

	return {
		answer,
		references: parseAskVideoReferences(answer),
	};
}

export { loadTranscriptVtt };
