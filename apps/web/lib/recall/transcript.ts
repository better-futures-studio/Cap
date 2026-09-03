const MAX_CUE_SECONDS = 12;
const MAX_CUE_WORDS = 25;
const MAX_GAP_SECONDS = 1.5;

export type RecallTranscriptWord = {
	text: string;
	start_timestamp: { relative: number };
	end_timestamp: { relative: number } | null;
};

export type RecallTranscriptParticipant = {
	id: number;
	name: string | null;
	is_host?: boolean | null;
	email?: string | null;
};

export type RecallTranscriptPart = {
	participant: RecallTranscriptParticipant;
	words: RecallTranscriptWord[];
};

type Cue = { start: number; end: number; speaker: string; text: string };

function speakerName(participant: RecallTranscriptParticipant): string {
	return participant.name?.trim() || "Speaker";
}

function buildCuesForPart(part: RecallTranscriptPart): Cue[] {
	const cues: Cue[] = [];
	let current: { start: number; end: number; words: string[] } | null = null;

	for (const word of part.words) {
		const wordStart = word.start_timestamp.relative;
		const wordEnd = word.end_timestamp?.relative ?? wordStart;

		if (current) {
			const gap = wordStart - current.end;
			const duration = wordEnd - current.start;
			const shouldBreak =
				gap > MAX_GAP_SECONDS ||
				duration > MAX_CUE_SECONDS ||
				current.words.length >= MAX_CUE_WORDS;

			if (shouldBreak) {
				cues.push({
					start: current.start,
					end: current.end,
					speaker: speakerName(part.participant),
					text: current.words.join(" "),
				});
				current = null;
			}
		}

		if (!current) current = { start: wordStart, end: wordEnd, words: [] };

		current.words.push(word.text);
		current.end = wordEnd;
	}

	if (current) {
		cues.push({
			start: current.start,
			end: current.end,
			speaker: speakerName(part.participant),
			text: current.words.join(" "),
		});
	}

	return cues;
}

function formatVttTimestamp(totalSeconds: number): string {
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

export function recallTranscriptToVtt(parts: RecallTranscriptPart[]): string {
	const cues = parts
		.flatMap(buildCuesForPart)
		.sort((a, b) => a.start - b.start);

	if (cues.length === 0) return "WEBVTT\n\n";

	const body = cues
		.map(
			(cue, index) =>
				`${index + 1}\n${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(
					cue.end,
				)}\n${cue.speaker}: ${cue.text}`,
		)
		.join("\n\n");

	return `WEBVTT\n\n${body}\n`;
}
