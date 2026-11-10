import { describe, expect, it, vi } from "vitest";
import {
	filterLibraryRecordings,
	type RecordingLibraryFilters,
	recordingCalendarDate,
} from "./recording-filters";

const defaults: RecordingLibraryFilters = {
	search: "",
	mode: "all",
	from: "",
	to: "",
	sort: "newest",
};

function recording(name: string, date: string, mode = "studio") {
	return {
		prettyName: name,
		path: `/recordings/${name}`,
		meta: { mode, sort_time_millis: new Date(date).getTime() },
	};
}

describe("desktop recording filters", () => {
	it("combines case-insensitive title search with recording mode", () => {
		const rows = [
			recording("Team standup", "2026-11-09T12:00:00Z"),
			recording("STANDUP notes", "2026-11-09T13:00:00Z", "instant"),
		];
		expect(
			filterLibraryRecordings(rows, {
				...defaults,
				search: "  STANDUP  ",
				mode: "instant",
			}).map((row) => row.prettyName),
		).toEqual(["STANDUP notes"]);
	});

	it("filters the complete library before the UI takes a page", () => {
		const rows = Array.from({ length: 50 }, (_, index) =>
			recording(
				`Cap ${index}`,
				`2026-11-09T12:${String(index).padStart(2, "0")}:00Z`,
			),
		);
		expect(
			filterLibraryRecordings(rows, { ...defaults, search: "Cap 49" }),
		).toEqual([rows[49]]);
	});

	it("includes the complete local final day across daylight-saving changes", () => {
		vi.stubEnv("TZ", "America/New_York");
		try {
			const rows = [
				recording("Before", "2026-03-08T04:59:59Z"),
				recording("First", "2026-03-08T05:00:00Z"),
				recording("Last", "2026-03-09T03:59:59Z"),
				recording("After", "2026-03-09T04:00:00Z"),
			];
			expect(
				filterLibraryRecordings(rows, {
					...defaults,
					from: "2026-03-08",
					to: "2026-03-08",
				}).map((row) => row.prettyName),
			).toEqual(["Last", "First"]);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("sorts by recording date without changing the source library", () => {
		const rows = [
			recording("New", "2026-11-10T12:00:00Z"),
			recording("Old", "2026-11-08T12:00:00Z"),
		];
		expect(
			filterLibraryRecordings(rows, { ...defaults, sort: "oldest" }).map(
				(row) => row.prettyName,
			),
		).toEqual(["Old", "New"]);
		expect(rows[0]?.prettyName).toBe("New");
		expect(
			filterLibraryRecordings(rows, defaults).map((row) => row.prettyName),
		).toEqual(["New", "Old"]);
	});

	it("supports open-ended ranges, reset filters, and empty results", () => {
		const rows = [recording("Meeting", "2026-11-09T12:00:00Z")];
		expect(
			filterLibraryRecordings(rows, { ...defaults, from: "2026-11-10" }),
		).toEqual([]);
		expect(
			filterLibraryRecordings(rows, { ...defaults, to: "2026-11-10" }),
		).toEqual(rows);
		expect(
			filterLibraryRecordings(rows, {
				...defaults,
				from: "2026-11-10",
				to: "2026-11-09",
			}),
		).toEqual([]);
		expect(filterLibraryRecordings(rows, defaults)).toEqual(rows);
	});

	it("shows a full calendar date and tolerates unavailable timestamps", () => {
		const label = recordingCalendarDate(
			new Date(2026, 10, 9, 12, 30).getTime(),
		);
		expect(label).toContain("2026");
		expect(label).not.toContain("ago");
		expect(recordingCalendarDate(Number.NaN)).toBe("Date unavailable");
	});
});
