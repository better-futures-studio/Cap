import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecallClient } from "@/lib/recall/client";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	start: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/schema", () => {
	const table = (name: string, fields: string[]) =>
		Object.fromEntries([
			["table", name],
			...fields.map((field) => [field, `${name}.${field}`]),
		]);
	return {
		meetingBots: table("meeting_bots", [
			"id",
			"source",
			"calendarEventId",
			"attendeeEmails",
			"attendeeNames",
			"joinAt",
			"recallBotId",
			"recallRecordingId",
			"videoId",
			"status",
			"statusSubCode",
			"updatedAt",
		]),
		meetingCalendars: table("meeting_calendars", [
			"id",
			"recallCalendarId",
			"status",
			"platformEmail",
			"disconnectReason",
			"updatedAt",
		]),
		meetingCalendarSeriesRules: table("meeting_calendar_series_rules", [
			"id",
			"calendarId",
			"seriesKey",
			"record",
		]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
	gte: (column: string, value: unknown) => ({ op: "gte", column, value }),
	isNull: (column: string) => ({ op: "isNull", column }),
	isNotNull: (column: string) => ({ op: "isNotNull", column }),
	asc: (column: string) => column,
	desc: (column: string) => column,
	inArray: (column: string, values: unknown[]) => ({
		op: "inArray",
		column,
		values,
	}),
	lt: (column: string, value: unknown) => ({ op: "lt", column, value }),
	notInArray: (column: string, values: unknown[]) => ({
		op: "notInArray",
		column,
		values,
	}),
}));
vi.mock("@/lib/recall/config", () => ({
	DEFAULT_BOT_NAME: "Meeting Notetaker",
	getRecallConfig: () => ({ botName: "Meeting Notetaker" }),
	isRecallConfigured: () => true,
}));
vi.mock("@/lib/recall/default-client", () => ({
	getDefaultRecallClient: () => {
		throw new Error("default Recall client should not be used in tests");
	},
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/recall-meeting", () => ({
	importRecallRecordingWorkflow: {},
}));
vi.mock("@/lib/recall/bots", () => ({
	reconcileStaleSchedulingRows: vi.fn(async () => 0),
}));
vi.mock("@/lib/recall/chat-comments", () => ({
	importMeetingChatComments: vi.fn(),
}));
vi.mock("@/lib/recall/recap", () => ({
	sendMeetingRecap: vi.fn(),
}));
vi.mock("@/lib/recall/visibility", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/recall/visibility")>();
	return {
		...actual,
		migrateMeetingSpacesToVideoShares: vi.fn(async () => ({
			spacesMigrated: 0,
			videosPrivatized: 0,
		})),
	};
});

type Row = Record<string, unknown>;
type Table = { table: string };
type Condition = {
	op: string;
	args?: (Condition | undefined)[];
	column?: string;
	value?: unknown;
	values?: unknown[];
};

let rows: Record<string, Row[]>;

function matches(row: Row, condition?: Condition): boolean {
	if (!condition) return true;
	if (condition.op === "and") {
		return (condition.args ?? []).every((part) => matches(row, part));
	}
	const key = condition.column?.split(".")[1] ?? "";
	if (condition.op === "eq") return row[key] === condition.value;
	if (condition.op === "isNull") return row[key] == null;
	if (condition.op === "isNotNull") return row[key] != null;
	if (condition.op === "gte") {
		const value = row[key];
		return value instanceof Date && condition.value instanceof Date
			? value >= condition.value
			: false;
	}
	if (condition.op === "lt") {
		const value = row[key];
		return value instanceof Date && condition.value instanceof Date
			? value < condition.value
			: false;
	}
	if (condition.op === "inArray") {
		return (
			Array.isArray(condition.values) && condition.values.includes(row[key])
		);
	}
	if (condition.op === "notInArray") {
		return (
			Array.isArray(condition.values) && !condition.values.includes(row[key])
		);
	}
	return true;
}

function createClient() {
	return {
		select() {
			let table = "";
			let condition: Condition | undefined;
			const run = () =>
				(rows[table] ?? []).filter((row) => matches(row, condition));
			const query = {
				from(value: Table) {
					table = value.table;
					return thenable();
				},
				where(value: Condition) {
					condition = value;
					return thenable();
				},
				orderBy() {
					return thenable();
				},
				limit: async (limit: number) => run().slice(0, limit),
			};
			function thenable() {
				return Object.assign(Promise.resolve().then(run), query);
			}
			return query;
		},
		update(table: Table) {
			return {
				set: (values: Row) => ({
					where: async (condition: Condition) => {
						for (const row of rows[table.table] ?? []) {
							if (matches(row, condition)) Object.assign(row, values);
						}
					},
				}),
			};
		},
	};
}

const {
	backfillCalendarAttendeeEmails,
	reconcileMissedDoneRows,
	syncCalendarStatuses,
} = await import("@/lib/recall/reconcile");

beforeEach(() => {
	rows = { meeting_bots: [], meeting_calendars: [] };
	mocks.db.mockReturnValue(createClient());
	mocks.start.mockReset();
});

describe("backfillCalendarAttendeeEmails", () => {
	it("fills attendeeEmails for calendar rows missing them", async () => {
		const joinAt = new Date("2026-09-01T10:00:00.000Z");
		rows.meeting_bots = [
			{
				id: "mb_1",
				source: "calendar",
				calendarEventId: "evt_1",
				attendeeEmails: null,
				joinAt,
			},
			{
				id: "mb_manual",
				source: "manual",
				calendarEventId: null,
				attendeeEmails: null,
				joinAt,
			},
		];
		const client = {
			getCalendarEvent: vi.fn(async () => ({
				id: "evt_1",
				raw: {
					attendees: [
						{ email: "Ada@example.com", displayName: "Ada" },
						{ email: "bea@example.com", displayName: "Bea" },
					],
				},
			})),
		} as unknown as RecallClient;

		await expect(
			backfillCalendarAttendeeEmails(client, new Date("2026-09-07T00:00:00Z")),
		).resolves.toBe(1);
		expect(client.getCalendarEvent).toHaveBeenCalledWith("evt_1");
		expect(rows.meeting_bots[0]?.attendeeEmails).toEqual([
			"ada@example.com",
			"bea@example.com",
		]);
		expect(rows.meeting_bots[0]?.attendeeNames).toEqual(["Ada", "Bea"]);
		expect(rows.meeting_bots[1]?.attendeeEmails).toBeNull();
	});
});

describe("reconcileMissedDoneRows", () => {
	const stale = new Date(Date.now() - 30 * 60 * 1000);

	it("marks a late row shared when a sibling is already importing", async () => {
		rows.meeting_bots = [
			{
				id: "mb_primary",
				recallBotId: "bot_1",
				recallRecordingId: "rec_1",
				videoId: "vid_1",
				status: "importing",
				statusSubCode: null,
				updatedAt: stale,
			},
			{
				id: "mb_late",
				recallBotId: "bot_1",
				recallRecordingId: null,
				videoId: null,
				status: "done",
				statusSubCode: null,
				updatedAt: stale,
			},
		];
		const client = {
			getBot: vi.fn(),
		} as unknown as RecallClient;

		await expect(reconcileMissedDoneRows(client)).resolves.toBe(0);
		expect(client.getBot).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(rows.meeting_bots[1]?.statusSubCode).toBe("shared:mb_primary");
	});

	it("promotes a shared row when the primary import failed", async () => {
		rows.meeting_bots = [
			{
				id: "mb_primary",
				recallBotId: "bot_1",
				recallRecordingId: "rec_1",
				videoId: "vid_1",
				status: "failed",
				statusSubCode: null,
				updatedAt: stale,
			},
			{
				id: "mb_shared",
				recallBotId: "bot_1",
				recallRecordingId: null,
				videoId: null,
				status: "done",
				statusSubCode: "shared:mb_primary",
				updatedAt: stale,
			},
		];
		const client = {
			getBot: vi.fn(async () => ({ recordings: [{ id: "rec_1" }] })),
		} as unknown as RecallClient;

		await expect(reconcileMissedDoneRows(client)).resolves.toBe(1);
		expect(client.getBot).toHaveBeenCalledWith("bot_1");
		expect(mocks.start).toHaveBeenCalledWith({}, [
			{ meetingBotId: "mb_shared", recordingId: "rec_1" },
		]);
	});
});

describe("syncCalendarStatuses", () => {
	it("updates a disconnected calendar and stores Recall's reason", async () => {
		rows.meeting_calendars = [
			{
				id: "cal_connected",
				recallCalendarId: "rc_connected",
				status: "connected",
				platformEmail: "ada@example.com",
				disconnectReason: null,
				updatedAt: new Date("2026-09-02T00:00:00.000Z"),
			},
			{
				id: "cal_disconnected",
				recallCalendarId: "rc_disconnected",
				status: "connected",
				platformEmail: "bea@example.com",
				disconnectReason: null,
				updatedAt: new Date("2026-09-01T00:00:00.000Z"),
			},
		];
		const client = {
			getCalendar: vi.fn(async (id: string) => {
				if (id === "rc_connected") {
					return {
						id,
						status: "connected",
						platform_email: "ada@example.com",
						status_changes: [],
					};
				}
				return {
					id,
					status: "disconnected",
					platform_email: "bea@example.com",
					status_changes: [
						{
							status: "connected",
							created_at: "2026-09-08T12:00:00.000Z",
							reason: "",
						},
						{
							status: "disconnected",
							created_at: "2026-09-08T12:00:00.300Z",
							reason: "Google Calendar API has not been used in project",
						},
					],
				};
			}),
		} as unknown as RecallClient;

		await expect(syncCalendarStatuses(client)).resolves.toBe(2);
		expect(client.getCalendar).toHaveBeenCalledTimes(2);

		const connected = rows.meeting_calendars.find(
			(row) => row.id === "cal_connected",
		);
		const disconnected = rows.meeting_calendars.find(
			(row) => row.id === "cal_disconnected",
		);
		expect(connected?.status).toBe("connected");
		expect(connected?.disconnectReason).toBeNull();
		expect(disconnected?.status).toBe("disconnected");
		expect(disconnected?.disconnectReason).toBe(
			"Google Calendar API has not been used in project",
		);
	});
});
