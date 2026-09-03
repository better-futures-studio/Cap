import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/recall/bot-image", () => ({
	loadBotVideoOutput: vi.fn(async () => null),
}));

import {
	calendarEventSeriesKey,
	decideCalendarEventAction,
} from "@/lib/recall/calendars";

const now = new Date("2024-01-01T12:00:00.000Z");

const futureEvent = {
	is_deleted: false,
	meeting_url: "https://meet.google.com/abc-defg-hij",
	end_time: "2024-01-01T13:00:00.000Z",
};

const pastEvent = {
	is_deleted: false,
	meeting_url: "https://meet.google.com/abc-defg-hij",
	end_time: "2023-12-31T13:00:00.000Z",
};

const deletedEvent = {
	is_deleted: true,
	meeting_url: "https://meet.google.com/abc-defg-hij",
	end_time: "2024-01-01T13:00:00.000Z",
};

describe("decideCalendarEventAction", () => {
	it("schedules a future event with a meeting url when auto-record is on", () => {
		expect(
			decideCalendarEventAction(futureEvent, { autoRecord: true }, null, now),
		).toBe("schedule");
	});

	it("does nothing without a meeting url", () => {
		expect(
			decideCalendarEventAction(
				{ ...futureEvent, meeting_url: null },
				{ autoRecord: true },
				null,
				now,
			),
		).toBe("none");
	});

	it("does nothing for events that have already ended", () => {
		expect(
			decideCalendarEventAction(pastEvent, { autoRecord: true }, null, now),
		).toBe("none");
	});

	it("cancels an existing non-terminal row when the event is deleted", () => {
		expect(
			decideCalendarEventAction(
				deletedEvent,
				{ autoRecord: true },
				{ status: "scheduled" },
				now,
			),
		).toBe("cancel");
	});

	it("leaves a deleted event with no local row alone", () => {
		expect(
			decideCalendarEventAction(deletedEvent, { autoRecord: true }, null, now),
		).toBe("none");
	});

	it("does not touch an already-terminal row when the event is deleted", () => {
		expect(
			decideCalendarEventAction(
				deletedEvent,
				{ autoRecord: true },
				{ status: "cancelled" },
				now,
			),
		).toBe("none");
	});

	it("never re-adds an event the user opted out of", () => {
		expect(
			decideCalendarEventAction(
				futureEvent,
				{ autoRecord: true },
				{ status: "opted_out" },
				now,
			),
		).toBe("none");
	});

	it("re-schedules an existing non-terminal row even with auto-record off", () => {
		expect(
			decideCalendarEventAction(
				futureEvent,
				{ autoRecord: false },
				{ status: "scheduled" },
				now,
			),
		).toBe("schedule");
	});

	it("does nothing when auto-record is off and there is no local row", () => {
		expect(
			decideCalendarEventAction(futureEvent, { autoRecord: false }, null, now),
		).toBe("none");
	});

	it("schedules from an explicit series rule when auto-record is off", () => {
		expect(
			decideCalendarEventAction(futureEvent, { autoRecord: false }, null, now, {
				record: true,
			}),
		).toBe("schedule");
	});

	it("does not schedule when a series rule says not to record, even if auto-record is on", () => {
		expect(
			decideCalendarEventAction(futureEvent, { autoRecord: true }, null, now, {
				record: false,
			}),
		).toBe("none");
	});

	it("keeps an opted-out event skipped even when the series rule says record", () => {
		expect(
			decideCalendarEventAction(
				futureEvent,
				{ autoRecord: false },
				{ status: "opted_out" },
				now,
				{ record: true },
			),
		).toBe("none");
	});

	it("keeps an existing non-terminal row scheduled when the series rule says not to record", () => {
		expect(
			decideCalendarEventAction(
				futureEvent,
				{ autoRecord: false },
				{ status: "scheduled" },
				now,
				{ record: false },
			),
		).toBe("schedule");
	});
});

describe("calendarEventSeriesKey", () => {
	it("uses Google recurringEventId when present", () => {
		expect(
			calendarEventSeriesKey({
				ical_uid: "abc123@google.com",
				raw: { recurringEventId: "series_1" },
			}),
		).toBe("series_1");
	});

	it("uses the ical_uid prefix before _R or @", () => {
		expect(
			calendarEventSeriesKey({
				ical_uid: "abc123_R20240101T120000@google.com",
				raw: {},
			}),
		).toBe("abc123");
		expect(
			calendarEventSeriesKey({
				ical_uid: "abc123@google.com",
				raw: {},
			}),
		).toBe("abc123");
	});

	it("returns null when there is no recurring marker", () => {
		expect(
			calendarEventSeriesKey({
				ical_uid: "plain-uid",
				raw: {},
			}),
		).toBeNull();
	});
});
