import { describe, expect, it } from "vitest";
import {
	type RecallTranscriptPart,
	recallTranscriptToVtt,
} from "@/lib/recall/transcript";

const word = (
	text: string,
	start: number,
	end: number,
): RecallTranscriptPart["words"][number] => ({
	text,
	start_timestamp: { relative: start },
	end_timestamp: { relative: end },
});

describe("recallTranscriptToVtt", () => {
	it("returns only the header for an empty transcript", () => {
		expect(recallTranscriptToVtt([])).toBe("WEBVTT\n\n");
	});

	it("builds cues for two speakers with names and correct timestamps", () => {
		const parts: RecallTranscriptPart[] = [
			{
				participant: { id: 1, name: "Alice" },
				words: [word("Hello", 0, 0.5), word("there", 0.6, 1)],
			},
			{
				participant: { id: 2, name: "Bob" },
				words: [word("Hi", 1.2, 1.5), word("Alice", 1.6, 2)],
			},
		];

		const vtt = recallTranscriptToVtt(parts);

		expect(vtt).toBe(
			"WEBVTT\n\n" +
				"1\n00:00:00.000 --> 00:00:01.000\nAlice: Hello there\n\n" +
				"2\n00:00:01.200 --> 00:00:02.000\nBob: Hi Alice\n",
		);
	});

	it("falls back to a generic speaker label when the name is missing", () => {
		const parts: RecallTranscriptPart[] = [
			{ participant: { id: 1, name: null }, words: [word("Hey", 0, 0.2)] },
		];

		expect(recallTranscriptToVtt(parts)).toContain("Speaker: Hey");
	});

	it("splits a speaker's words into a new cue after a gap over 1.5s", () => {
		const parts: RecallTranscriptPart[] = [
			{
				participant: { id: 1, name: "Alice" },
				words: [
					word("First", 0, 0.5),
					word("sentence.", 0.6, 1),
					word("Second", 3, 3.5),
					word("sentence.", 3.6, 4),
				],
			},
		];

		const vtt = recallTranscriptToVtt(parts);
		const cues = vtt.trim().split("\n\n").slice(1);

		expect(cues).toHaveLength(2);
		expect(cues[0]).toContain("Alice: First sentence.");
		expect(cues[1]).toContain("Alice: Second sentence.");
	});

	it("splits a cue once it exceeds the max word count", () => {
		const words = Array.from({ length: 30 }, (_, index) =>
			word(`word${index}`, index * 0.2, index * 0.2 + 0.1),
		);
		const parts: RecallTranscriptPart[] = [
			{ participant: { id: 1, name: "Alice" }, words },
		];

		const vtt = recallTranscriptToVtt(parts);
		const cues = vtt.trim().split("\n\n").slice(1);

		expect(cues.length).toBeGreaterThan(1);
	});
});
