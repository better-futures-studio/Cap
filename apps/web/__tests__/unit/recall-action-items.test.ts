import { describe, expect, it } from "vitest";
import {
	mergeMeetingActionItems,
	parseCapturedActionItem,
	parseMeetingActionItems,
} from "@/lib/recall/action-items";

describe("parseMeetingActionItems", () => {
	it("keeps valid items and drops empty text", () => {
		expect(
			parseMeetingActionItems([
				{ text: "Ship the recap", owner: "Ada", due: "Friday" },
				{ text: "  ", owner: "Ada", due: null },
				{ text: "Write docs", owner: null, due: null },
				{ text: 1 },
			]),
		).toEqual([
			{ text: "Ship the recap", owner: "Ada", due: "Friday" },
			{ text: "Write docs", owner: null, due: null },
		]);
	});
});

describe("parseCapturedActionItem", () => {
	it("reads comments prefixed with Action item:", () => {
		expect(
			parseCapturedActionItem("Action item: Follow up with legal"),
		).toEqual({
			text: "Follow up with legal",
			owner: null,
			due: null,
		});
		expect(parseCapturedActionItem("Action item: Ada: Send the deck")).toEqual({
			text: "Send the deck",
			owner: "Ada",
			due: null,
		});
	});

	it("ignores notes and other comments", () => {
		expect(parseCapturedActionItem("Note: Remember this")).toBeNull();
		expect(parseCapturedActionItem("Ada: Action item: hidden")).toBeNull();
	});
});

describe("mergeMeetingActionItems", () => {
	it("merges captured comments with AI items and dedupes by text", () => {
		expect(
			mergeMeetingActionItems(
				[
					{ text: "Follow up with legal", owner: "Ada", due: "Friday" },
					{ text: "Draft the proposal", owner: null, due: null },
					{ text: "Ship the recap", owner: "Bea", due: null },
				],
				[
					{ content: "Action item: Follow up with legal" },
					{ content: "Action item: Cam: Book the room" },
					{ content: "Note: ignore me" },
				],
			),
		).toEqual([
			{ text: "Follow up with legal", owner: null, due: null },
			{ text: "Book the room", owner: "Cam", due: null },
			{ text: "Draft the proposal", owner: null, due: null },
			{ text: "Ship the recap", owner: "Bea", due: null },
		]);
	});

	it("caps the list at 15 and ignores duplicate casing", () => {
		const comments = Array.from({ length: 12 }, (_, index) => ({
			content: `Action item: Captured ${index}`,
		}));
		const aiItems = [
			{ text: "captured 0", owner: "Ada", due: null },
			{ text: "AI extra 1", owner: null, due: null },
			{ text: "AI extra 2", owner: null, due: null },
			{ text: "AI extra 3", owner: null, due: null },
			{ text: "AI extra 4", owner: null, due: null },
		];
		const merged = mergeMeetingActionItems(aiItems, comments);
		expect(merged).toHaveLength(15);
		expect(merged[0]).toEqual({
			text: "Captured 0",
			owner: null,
			due: null,
		});
		expect(merged.at(-1)?.text).toBe("AI extra 3");
	});
});
