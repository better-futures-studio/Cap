import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/recall/bot-image", () => ({
	loadBotVideoOutput: vi.fn(async () => null),
}));

import { decideCalendarEventAction } from "@/lib/recall/calendars";

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
});
