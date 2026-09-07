import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRecallWebhook } from "@/lib/recall/webhooks";

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
			"calendarEventId",
			"recallBotId",
			"recallRecordingId",
			"videoId",
			"status",
			"statusSubCode",
			"createdAt",
		]),
		organizations: table("organizations", ["id"]),
		slackHuddleTeams: table("slack_huddle_teams", ["id"]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
	inArray: (column: string, value: unknown[]) => ({ op: "in", column, value }),
	notInArray: (column: string, value: unknown[]) => ({
		op: "notIn",
		column,
		value,
	}),
	isNull: (column: string) => ({ op: "isNull", column }),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ CAP_DEFAULT_ORG_ID: "org_1" }),
}));
vi.mock("@/lib/recall/config", () => ({
	DEFAULT_BOT_NAME: "Meeting Notetaker",
	getRecallConfig: () => null,
	isRecallConfigured: () => true,
}));
vi.mock("@/lib/recall/default-client", () => ({
	getDefaultRecallClient: () => {
		throw new Error("default Recall client should not be used in tests");
	},
}));
vi.mock("@/lib/recall/bots", () => ({
	applyBotStatusEvent: vi.fn(),
}));
vi.mock("@/lib/recall/calendars", () => ({
	syncCalendarStatus: vi.fn(),
}));
vi.mock("@/workflows/recall-calendar-sync", () => ({
	syncCalendarEventsWorkflow: {},
}));
vi.mock("@/workflows/recall-meeting", () => ({
	completeRecallTranscriptWorkflow: {},
	failRecallTranscriptWorkflow: {},
	importRecallRecordingWorkflow: { name: "importRecallRecordingWorkflow" },
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));

type Row = Record<string, unknown>;
type Table = { table: string };
type Condition = {
	op: string;
	args?: (Condition | undefined)[];
	column?: string;
	value?: unknown;
};

let rows: Record<string, Row[]>;
const now = new Date("2026-09-03T16:00:00.000Z");

function matches(row: Row, condition?: Condition): boolean {
	if (!condition) return true;
	if (condition.op === "and") {
		return (condition.args ?? []).every((part) => matches(row, part));
	}
	const key = condition.column?.split(".")[1] ?? "";
	if (condition.op === "eq") return row[key] === condition.value;
	if (condition.op === "isNull") return row[key] == null;
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

beforeEach(() => {
	rows = { meeting_bots: [] };
	mocks.db.mockReturnValue(createClient());
	mocks.start.mockReset();
});

describe("handleRecordingDone", () => {
	it("marks a late row shared when a sibling is already importing", async () => {
		rows.meeting_bots = [
			{
				id: "mb_primary",
				calendarEventId: "evt_1",
				recallBotId: "bot_1",
				recallRecordingId: "rec_1",
				videoId: "vid_1",
				status: "importing",
				statusSubCode: null,
				createdAt: now,
			},
			{
				id: "mb_late",
				calendarEventId: null,
				recallBotId: "bot_1",
				recallRecordingId: null,
				videoId: null,
				status: "done",
				statusSubCode: null,
				createdAt: new Date(now.getTime() + 1000),
			},
		];

		await dispatchRecallWebhook({
			event: "recording.done",
			data: {
				bot: { id: "bot_1" },
				recording: { id: "rec_1" },
			},
		});

		expect(mocks.start).not.toHaveBeenCalled();
		expect(rows.meeting_bots[1]?.statusSubCode).toBe("shared:mb_primary");
	});

	it("promotes a late row when the primary import failed", async () => {
		rows.meeting_bots = [
			{
				id: "mb_primary",
				calendarEventId: "evt_1",
				recallBotId: "bot_1",
				recallRecordingId: "rec_1",
				videoId: "vid_1",
				status: "failed",
				statusSubCode: null,
				createdAt: now,
			},
			{
				id: "mb_late",
				calendarEventId: null,
				recallBotId: "bot_1",
				recallRecordingId: null,
				videoId: null,
				status: "done",
				statusSubCode: "shared:mb_primary",
				createdAt: new Date(now.getTime() + 1000),
			},
		];

		await dispatchRecallWebhook({
			event: "recording.done",
			data: {
				bot: { id: "bot_1" },
				recording: { id: "rec_1" },
			},
		});

		expect(mocks.start).toHaveBeenCalledWith(
			{ name: "importRecallRecordingWorkflow" },
			[{ meetingBotId: "mb_late", recordingId: "rec_1" }],
		);
	});
});
