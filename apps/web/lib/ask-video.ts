export type AskVideoMessage = { role: "user" | "assistant"; content: string };
export type AskVideoReference = { seconds: number; label: string };
export type AskVideoResult = {
	answer: string;
	references: AskVideoReference[];
};

export const ASK_TRANSCRIPT_MAX_CHARS = 60_000;
export const ASK_HISTORY_LIMIT = 10;

const TIMESTAMP_MARKER = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g;
const TRIM_MARKER = "\n\n[Transcript trimmed: middle omitted]\n\n";

export function parseAskVideoReferences(answer: string): AskVideoReference[] {
	const seen = new Set<number>();
	const references: AskVideoReference[] = [];
	for (const match of answer.matchAll(TIMESTAMP_MARKER)) {
		const hours = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
		const minutes = Number.parseInt(match[2] ?? "0", 10);
		const seconds = Number.parseInt(match[3] ?? "0", 10);
		const total = hours * 3600 + minutes * 60 + seconds;
		if (seen.has(total)) continue;
		seen.add(total);
		references.push({
			seconds: total,
			label: match[0].slice(1, -1),
		});
	}
	return references.sort((left, right) => left.seconds - right.seconds);
}

export function trimTranscriptForAsk(
	text: string,
	maxChars = ASK_TRANSCRIPT_MAX_CHARS,
): { text: string; trimmed: boolean } {
	// ponytail: 60k head+tail keeps opening context and the latest discussion without a retrieval index.
	if (text.length <= maxChars) return { text, trimmed: false };
	const keep = Math.max(0, Math.floor((maxChars - TRIM_MARKER.length) / 2));
	return {
		text: `${text.slice(0, keep)}${TRIM_MARKER}${text.slice(-keep)}`,
		trimmed: true,
	};
}

export function normalizeAskVideoHistory(
	history: AskVideoMessage[] | undefined,
): AskVideoMessage[] {
	if (!history) return [];
	return history
		.filter(
			(message) =>
				(message.role === "user" || message.role === "assistant") &&
				typeof message.content === "string" &&
				message.content.trim().length > 0,
		)
		.slice(-ASK_HISTORY_LIMIT)
		.map((message) => ({
			role: message.role,
			content: message.content,
		}));
}

export function formatAskTimestamp(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	const mm = String(minutes).padStart(2, "0");
	const ss = String(rest).padStart(2, "0");
	return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function parseVttCuesWithTimestamps(
	vttContent: string,
): { start: number; text: string }[] {
	const lines = vttContent.split("\n");
	const segments: { start: number; text: string }[] = [];
	let currentStart = 0;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.includes("-->")) {
			const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
			if (timeMatch) {
				currentStart =
					Number.parseInt(timeMatch[1] ?? "0", 10) * 3600 +
					Number.parseInt(timeMatch[2] ?? "0", 10) * 60 +
					Number.parseInt(timeMatch[3] ?? "0", 10);
			}
			continue;
		}
		if (
			line &&
			line !== "WEBVTT" &&
			!/^\d+$/.test(line) &&
			!line.includes("-->")
		) {
			segments.push({ start: currentStart, text: line });
		}
	}

	return segments;
}

export function formatAskTranscript(vttContent: string): {
	text: string;
	trimmed: boolean;
} {
	const formatted = parseVttCuesWithTimestamps(vttContent)
		.map((segment) => `[${formatAskTimestamp(segment.start)}] ${segment.text}`)
		.join("\n");
	return trimTranscriptForAsk(formatted);
}

export function askVideoSystemPrompt(trimmed: boolean): string {
	return [
		"Answer only from the provided material. Do not use outside knowledge.",
		"Write plain prose in the language of the question.",
		"Cite moments as [mm:ss] or [h:mm:ss] taken from the cue timestamps in the transcript.",
		trimmed
			? "The transcript was trimmed to the beginning and the end to fit the context budget."
			: "",
	]
		.filter(Boolean)
		.join(" ");
}
