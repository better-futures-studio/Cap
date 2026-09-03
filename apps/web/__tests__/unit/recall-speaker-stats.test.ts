import { describe, expect, it } from "vitest";
import { computeSpeakerStats } from "@/lib/recall/speaker-stats";
import type { RecallTranscriptPart } from "@/lib/recall/transcript";

const word = (
	text: string,
	start: number,
	end: number,
): RecallTranscriptPart["words"][number] => ({
	text,
	start_timestamp: { relative: start },
	end_timestamp: { relative: end },
});

describe("computeSpeakerStats", () => {
	it("computes talk time, questions, and longest monologue for two speakers", () => {
		const parts: RecallTranscriptPart[] = [
			{
				participant: { id: 1, name: "Alice" },
				words: [
					word("Hello", 0, 2),
					word("there", 2, 4),
					word("How", 4, 4.5),
					word("are", 4.5, 5),
					word("you?", 5, 6),
				],
			},
			{
				participant: { id: 2, name: "Bob" },
				words: [word("Fine", 6, 7), word("thanks", 7, 8)],
			},
			{
				participant: { id: 1, name: "Alice" },
				words: [word("Great", 20, 21), word("continue", 21, 22)],
			},
		];

		const stats = computeSpeakerStats(parts);

		expect(stats.totalSpeakingSeconds).toBe(10);
		expect(stats.speakers.map((speaker) => speaker.name)).toEqual([
			"Alice",
			"Bob",
		]);
		expect(stats.speakers[0]).toMatchObject({
			name: "Alice",
			speakingSeconds: 8,
			turns: 2,
			words: 7,
			questions: 1,
			longestMonologueSeconds: 6,
			share: 0.8,
		});
		expect(stats.speakers[1]).toMatchObject({
			name: "Bob",
			speakingSeconds: 2,
			turns: 1,
			words: 2,
			questions: 0,
			longestMonologueSeconds: 2,
			share: 0.2,
		});
	});

	it("counts overlapping words for each speaker independently", () => {
		const parts: RecallTranscriptPart[] = [
			{
				participant: { id: 1, name: "Alice" },
				words: [word("Wait", 0, 2)],
			},
			{
				participant: { id: 2, name: "Bob" },
				words: [word("Hold", 1, 3)],
			},
		];

		const stats = computeSpeakerStats(parts);

		expect(stats.totalSpeakingSeconds).toBe(4);
		expect(stats.speakers[0]?.speakingSeconds).toBe(2);
		expect(stats.speakers[1]?.speakingSeconds).toBe(2);
		expect(stats.speakers[0]?.share).toBe(0.5);
		expect(stats.speakers[1]?.share).toBe(0.5);
	});
});
