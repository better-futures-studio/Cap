import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type {
	MeetingSpeakerStat,
	MeetingSpeakerStats,
	VideoMetadata,
} from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type { RecallTranscriptPart } from "./transcript";

export type { MeetingSpeakerStat, MeetingSpeakerStats };

const MONOLOGUE_GAP_SECONDS = 1.5;

function speakerName(part: RecallTranscriptPart): string {
	return part.participant.name?.trim() || "Speaker";
}

function partText(part: RecallTranscriptPart): string {
	return part.words
		.map((word) => word.text)
		.join(" ")
		.trim();
}

function wordDuration(word: RecallTranscriptPart["words"][number]): number {
	const start = word.start_timestamp.relative;
	const end = word.end_timestamp?.relative ?? start;
	return Math.max(0, end - start);
}

function longestMonologueSeconds(part: RecallTranscriptPart): number {
	let longest = 0;
	let runStart: number | null = null;
	let runEnd: number | null = null;

	for (const word of part.words) {
		const start = word.start_timestamp.relative;
		const end = word.end_timestamp?.relative ?? start;
		if (runStart === null || runEnd === null) {
			runStart = start;
			runEnd = end;
			continue;
		}
		if (start - runEnd > MONOLOGUE_GAP_SECONDS) {
			longest = Math.max(longest, runEnd - runStart);
			runStart = start;
		}
		runEnd = Math.max(runEnd, end);
	}

	if (runStart !== null && runEnd !== null) {
		longest = Math.max(longest, runEnd - runStart);
	}
	return longest;
}

export function computeSpeakerStats(
	parts: RecallTranscriptPart[],
): MeetingSpeakerStats {
	const byName = new Map<
		string,
		{
			name: string;
			speakingSeconds: number;
			turns: number;
			words: number;
			questions: number;
			longestMonologueSeconds: number;
		}
	>();

	for (const part of parts) {
		if (part.words.length === 0) continue;
		const name = speakerName(part);
		const current = byName.get(name) ?? {
			name,
			speakingSeconds: 0,
			turns: 0,
			words: 0,
			questions: 0,
			longestMonologueSeconds: 0,
		};
		current.speakingSeconds += part.words.reduce(
			(sum, word) => sum + wordDuration(word),
			0,
		);
		current.turns += 1;
		current.words += part.words.length;
		if (partText(part).endsWith("?")) current.questions += 1;
		current.longestMonologueSeconds = Math.max(
			current.longestMonologueSeconds,
			longestMonologueSeconds(part),
		);
		byName.set(name, current);
	}

	const totalSpeakingSeconds = [...byName.values()].reduce(
		(sum, speaker) => sum + speaker.speakingSeconds,
		0,
	);
	const speakers = [...byName.values()]
		.map((speaker) => ({
			...speaker,
			share:
				totalSpeakingSeconds > 0
					? speaker.speakingSeconds / totalSpeakingSeconds
					: 0,
		}))
		.sort((a, b) => b.speakingSeconds - a.speakingSeconds);

	return { speakers, totalSpeakingSeconds };
}

export function parseMeetingSpeakerStats(
	value: unknown,
): MeetingSpeakerStats | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const totalSpeakingSeconds =
		typeof record.totalSpeakingSeconds === "number" &&
		Number.isFinite(record.totalSpeakingSeconds)
			? Math.max(0, record.totalSpeakingSeconds)
			: 0;
	if (!Array.isArray(record.speakers)) {
		return { speakers: [], totalSpeakingSeconds };
	}
	const speakers: MeetingSpeakerStat[] = [];
	for (const item of record.speakers) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		const name = typeof row.name === "string" ? row.name.trim() : "";
		if (!name) continue;
		speakers.push({
			name,
			speakingSeconds:
				typeof row.speakingSeconds === "number" ? row.speakingSeconds : 0,
			turns: typeof row.turns === "number" ? row.turns : 0,
			words: typeof row.words === "number" ? row.words : 0,
			questions: typeof row.questions === "number" ? row.questions : 0,
			longestMonologueSeconds:
				typeof row.longestMonologueSeconds === "number"
					? row.longestMonologueSeconds
					: 0,
			share: typeof row.share === "number" ? row.share : 0,
		});
	}
	return { speakers, totalSpeakingSeconds };
}

export function formatTalkTimeLine(
	stats: MeetingSpeakerStats | null | undefined,
): string | null {
	if (
		!stats ||
		stats.speakers.length === 0 ||
		stats.totalSpeakingSeconds <= 0
	) {
		return null;
	}
	const parts = stats.speakers.map(
		(speaker) => `${speaker.name} ${Math.round(speaker.share * 100)}%`,
	);
	return `Talk time: ${parts.join(", ")}`;
}

export async function getMeetingSpeakerStats(
	videoId: string,
): Promise<MeetingSpeakerStats | null> {
	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	return parseMeetingSpeakerStats(
		(video?.metadata as VideoMetadata | undefined)?.meetingSpeakerStats,
	);
}
