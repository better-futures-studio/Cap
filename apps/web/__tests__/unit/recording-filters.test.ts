import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it, vi } from "vitest";
import {
	hasRecordingFilters,
	readRecordingFilters,
	readRecordingPage,
	recordingDateBounds,
	recordingDateInput,
	recordingPageHref,
} from "@/lib/recordings/filters";
import {
	capRecordingConditions,
	meetingRecordingConditions,
} from "@/lib/recordings/search-conditions";

describe("recording search filters", () => {
	it("normalizes URL values and ignores malformed or repeated inputs", () => {
		expect(readRecordingFilters({ q: "  Planning  ", sort: "oldest" })).toEqual(
			{
				q: "Planning",
				sort: "oldest",
				from: undefined,
				to: undefined,
			},
		);
		expect(
			readRecordingFilters({
				q: ["one", "two"],
				from: "2026-02-30T00:00:00.000Z",
				to: "invalid",
				sort: "invalid",
			}),
		).toEqual({
			q: "",
			sort: "newest",
			from: undefined,
			to: undefined,
		});
		expect(hasRecordingFilters(readRecordingFilters({ sort: "oldest" }))).toBe(
			false,
		);
		expect(readRecordingFilters({ q: "x".repeat(300) }).q).toHaveLength(255);
	});

	it("accepts only positive integer page numbers", () => {
		for (const value of [undefined, [], "-1", "0", "1.5", "Infinity", "NaN"]) {
			expect(readRecordingPage(value)).toBe(1);
		}
		expect(readRecordingPage("3")).toBe(3);
	});

	it("preserves search, dates, sort and the meeting tab across pages", () => {
		const href = recordingPageHref(
			"/dashboard/meetings",
			"q=Planning&from=2026-11-08T22%3A00%3A00.000Z&sort=oldest&tab=past&page=1",
			2,
		);
		const params = new URL(href, "https://cap.test").searchParams;
		expect(params.get("q")).toBe("Planning");
		expect(params.get("from")).toBe("2026-11-08T22:00:00.000Z");
		expect(params.get("sort")).toBe("oldest");
		expect(params.get("tab")).toBe("past");
		expect(params.get("page")).toBe("2");
	});

	it("includes the entire selected local day, respecting daylight saving", () => {
		vi.stubEnv("TZ", "America/New_York");
		try {
			const bounds = recordingDateBounds("2026-03-08", "2026-03-08");
			expect(bounds).toEqual({
				from: "2026-03-08T05:00:00.000Z",
				to: "2026-03-09T04:00:00.000Z",
			});
			expect(recordingDateInput(bounds.from)).toBe("2026-03-08");
			expect(recordingDateInput(bounds.to, true)).toBe("2026-03-08");
			expect(recordingDateBounds("", "")).toEqual({
				from: undefined,
				to: undefined,
			});
			expect(() => recordingDateBounds("2026-11-10", "2026-11-09")).toThrow(
				"valid date range",
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("uses literal case-insensitive search and the effective Cap date", () => {
		const condition = capRecordingConditions(
			readRecordingFilters({
				q: "Planning_50%!",
				from: "2026-11-08T22:00:00.000Z",
				to: "2026-11-09T22:00:00.000Z",
			}),
		);
		expect(condition).toBeDefined();
		if (!condition) throw new Error("Missing condition");
		const query = new MySqlDialect().sqlToQuery(condition);
		expect(query.sql).toContain("LOWER(`videos`.`name`)");
		expect(query.sql).toContain("exists (SELECT 1 FROM `meeting_bots`");
		expect(query.sql).toContain("`meeting_bots`.`videoId` = `videos`.`id`");
		expect(query.sql).toContain("`meeting_bots`.`orgId` = `videos`.`orgId`");
		expect(query.sql).toContain("`videos`.`effectiveCreatedAt` >= ?");
		expect(query.sql).toContain("`videos`.`effectiveCreatedAt` < ?");
		expect(query.params.slice(0, 3)).toEqual(
			Array(3).fill("%planning!_50!%!!%"),
		);
	});

	it("searches meeting names and links using the meeting date", () => {
		const condition = meetingRecordingConditions(
			readRecordingFilters({ q: "standup", from: "2026-11-09T00:00:00.000Z" }),
		);
		if (!condition) throw new Error("Missing condition");
		const query = new MySqlDialect().sqlToQuery(condition);
		expect(query.sql).toContain("LOWER(`meeting_bots`.`title`)");
		expect(query.sql).toContain("LOWER(`meeting_bots`.`meetingUrl`)");
		expect(query.sql).toContain("`meeting_bots`.`joinAt` >= ?");
		expect(capRecordingConditions(readRecordingFilters({}))).toBeUndefined();
		expect(
			meetingRecordingConditions(readRecordingFilters({})),
		).toBeUndefined();
	});
});
