import { ASK_TRANSCRIPT_MAX_CHARS, formatAskTimestamp } from "@/lib/ask-video";

export type McpTranscriptCue = {
	start: number;
	end: number;
	speaker: string;
	text: string;
};

const SPEAKER_LINE = /^([^:]{1,80}):\s*(.*)$/;

export function parseVttCuesWithSpeakers(
	vttContent: string,
): McpTranscriptCue[] {
	const lines = vttContent.split("\n");
	const cues: McpTranscriptCue[] = [];
	let currentStart = 0;
	let currentEnd = 0;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.includes("-->")) {
			const times = line.match(
				/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/,
			);
			if (times) {
				currentStart =
					Number.parseInt(times[1] ?? "0", 10) * 3600 +
					Number.parseInt(times[2] ?? "0", 10) * 60 +
					Number.parseInt(times[3] ?? "0", 10);
				currentEnd =
					Number.parseInt(times[5] ?? "0", 10) * 3600 +
					Number.parseInt(times[6] ?? "0", 10) * 60 +
					Number.parseInt(times[7] ?? "0", 10);
			}
			continue;
		}
		if (
			!line ||
			line === "WEBVTT" ||
			/^\d+$/.test(line) ||
			line.includes("-->")
		) {
			continue;
		}
		const speakerMatch = line.match(SPEAKER_LINE);
		cues.push({
			start: currentStart,
			end: currentEnd,
			speaker: speakerMatch?.[1]?.trim() || "Speaker",
			text: (speakerMatch?.[2] ?? line).trim(),
		});
	}

	return cues;
}

export function trimTranscriptCues(
	cues: McpTranscriptCue[],
	startSeconds?: number,
	endSeconds?: number,
) {
	return cues.filter((cue) => {
		if (startSeconds !== undefined && cue.end < startSeconds) return false;
		if (endSeconds !== undefined && cue.start > endSeconds) return false;
		return true;
	});
}

export function formatTranscriptText(cues: McpTranscriptCue[]) {
	return cues
		.map(
			(cue) => `[${formatAskTimestamp(cue.start)}] ${cue.speaker}: ${cue.text}`,
		)
		.join("\n");
}

export function formatTranscriptVtt(cues: McpTranscriptCue[]) {
	if (cues.length === 0) return "WEBVTT\n\n";
	const body = cues
		.map((cue, index) => {
			const start = formatVttTimestamp(cue.start);
			const end = formatVttTimestamp(
				cue.end > cue.start ? cue.end : cue.start + 1,
			);
			return `${index + 1}\n${start} --> ${end}\n${cue.speaker}: ${cue.text}`;
		})
		.join("\n\n");
	return `WEBVTT\n\n${body}\n`;
}

function formatVttTimestamp(totalSeconds: number) {
	const totalMs = Math.max(0, Math.round(totalSeconds * 1000));
	const milliseconds = totalMs % 1000;
	const totalWholeSeconds = Math.floor(totalMs / 1000);
	const seconds = totalWholeSeconds % 60;
	const minutes = Math.floor(totalWholeSeconds / 60) % 60;
	const hours = Math.floor(totalWholeSeconds / 3600);
	return `${hours.toString().padStart(2, "0")}:${minutes
		.toString()
		.padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${milliseconds
		.toString()
		.padStart(3, "0")}`;
}

export function capTranscriptText(
	text: string,
	maxChars = ASK_TRANSCRIPT_MAX_CHARS,
) {
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}
	return {
		text: `${text.slice(0, maxChars)}\n\n[Transcript truncated at ${maxChars} characters]`,
		truncated: true,
	};
}

export function vttToPlainText(vttContent: string) {
	return parseVttCuesWithSpeakers(vttContent)
		.map((cue) => `${cue.speaker}: ${cue.text}`)
		.join("\n");
}
