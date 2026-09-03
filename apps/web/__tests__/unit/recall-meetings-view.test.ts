import { describe, expect, it } from "vitest";
import {
	groupByDay,
	meetingPlatformLabel,
	meetingUrlLabel,
} from "@/lib/recall/meetings-view";

describe("meetingPlatformLabel", () => {
	it("detects each supported platform", () => {
		expect(meetingPlatformLabel("https://zoom.us/j/123")).toBe("Zoom");
		expect(meetingPlatformLabel("https://meet.google.com/abc-defg-hij")).toBe(
			"Google Meet",
		);
		expect(meetingPlatformLabel("https://teams.microsoft.com/l/x")).toBe(
			"Microsoft Teams",
		);
		expect(meetingPlatformLabel("https://teams.live.com/l/x")).toBe(
			"Microsoft Teams",
		);
		expect(meetingPlatformLabel("https://company.webex.com/meet/x")).toBe(
			"Webex",
		);
	});

	it("falls back to a generic label for unknown or invalid URLs", () => {
		expect(meetingPlatformLabel("https://example.com/call")).toBe("Meeting");
		expect(meetingPlatformLabel("not a url")).toBe("Meeting");
	});

	it("labels Slack huddles when the URL is empty", () => {
		expect(meetingPlatformLabel("", "slack")).toBe("Slack Huddle");
		expect(meetingPlatformLabel("https://zoom.us/j/123", "slack")).toBe("Zoom");
	});
});

describe("meetingUrlLabel", () => {
	it("returns host plus path", () => {
		expect(meetingUrlLabel("https://meet.google.com/abc-defg-hij")).toBe(
			"meet.google.com/abc-defg-hij",
		);
	});

	it("returns just the host when there is no path", () => {
		expect(meetingUrlLabel("https://zoom.us")).toBe("zoom.us");
	});
});

describe("groupByDay", () => {
	const now = new Date("2026-09-03T12:00:00Z");

	it("groups today's items under Today", () => {
		const items = [new Date("2026-09-03T15:00:00Z")];
		const groups = groupByDay(items, now, (d) => d);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe("Today");
	});

	it("groups tomorrow's items under Tomorrow", () => {
		const items = [new Date("2026-09-04T09:00:00Z")];
		const groups = groupByDay(items, now, (d) => d);
		expect(groups[0]?.label).toBe("Tomorrow");
	});

	it("labels other days with a weekday-month-day string", () => {
		const items = [new Date("2026-09-10T09:00:00Z")];
		const groups = groupByDay(items, now, (d) => d);
		expect(groups[0]?.label).toMatch(/\w{3}, \w{3} \d{1,2}/);
	});

	it("orders items soonest first across days", () => {
		const items = [
			new Date("2026-09-10T09:00:00Z"),
			new Date("2026-09-03T15:00:00Z"),
			new Date("2026-09-04T09:00:00Z"),
		];
		const groups = groupByDay(items, now, (d) => d);
		expect(groups.map((g) => g.label)).toEqual([
			"Today",
			"Tomorrow",
			expect.stringContaining("Sep 10"),
		]);
	});
});
