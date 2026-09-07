import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimMeetingBotImport } from "@/lib/recall/shared-recording";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
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
			"recallBotId",
			"recallRecordingId",
			"videoId",
			"status",
			"statusSubCode",
			"errorMessage",
		]),
	};
});
vi.mock("drizzle-orm", () => ({
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
}));

type Row = Record<string, unknown>;
type Table = { table: string };
type Condition = {
	op: string;
	column?: string;
	value?: unknown;
};

let rows: Record<string, Row[]>;

function matches(row: Row, condition?: Condition): boolean {
	if (!condition) return true;
	const key = condition.column?.split(".")[1] ?? "";
	if (condition.op === "eq") return row[key] === condition.value;
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
});

describe("claimMeetingBotImport", () => {
	it("refuses a duplicate and marks the row shared", async () => {
		rows.meeting_bots = [
			{
				id: "mb_primary",
				recallBotId: "bot_1",
				recallRecordingId: "rec_1",
				videoId: "vid_1",
				status: "importing",
				statusSubCode: null,
			},
			{
				id: "mb_late",
				recallBotId: "bot_1",
				recallRecordingId: null,
				videoId: null,
				status: "done",
				statusSubCode: null,
			},
		];

		await expect(
			claimMeetingBotImport({ meetingBotId: "mb_late", recordingId: "rec_1" }),
		).resolves.toBe(false);
		expect(rows.meeting_bots[1]?.statusSubCode).toBe("shared:mb_primary");
		expect(rows.meeting_bots[1]?.recallRecordingId).toBeNull();
		expect(rows.meeting_bots[1]?.status).toBe("done");
	});

	it("claims when no sibling holds the recording", async () => {
		rows.meeting_bots = [
			{
				id: "mb_1",
				recallBotId: "bot_1",
				recallRecordingId: null,
				videoId: null,
				status: "done",
				statusSubCode: null,
				errorMessage: null,
			},
		];

		await expect(
			claimMeetingBotImport({ meetingBotId: "mb_1", recordingId: "rec_1" }),
		).resolves.toBe(true);
		expect(rows.meeting_bots[0]?.status).toBe("importing");
		expect(rows.meeting_bots[0]?.recallRecordingId).toBe("rec_1");
		expect(rows.meeting_bots[0]?.statusSubCode).toBeNull();
	});

	it("promotes a shared row after the primary import failed", async () => {
		rows.meeting_bots = [
			{
				id: "mb_primary",
				recallBotId: "bot_1",
				recallRecordingId: "rec_1",
				videoId: "vid_1",
				status: "failed",
				statusSubCode: null,
			},
			{
				id: "mb_shared",
				recallBotId: "bot_1",
				recallRecordingId: null,
				videoId: null,
				status: "done",
				statusSubCode: "shared:mb_primary",
			},
		];

		await expect(
			claimMeetingBotImport({
				meetingBotId: "mb_shared",
				recordingId: "rec_1",
			}),
		).resolves.toBe(true);
		expect(rows.meeting_bots[1]?.status).toBe("importing");
		expect(rows.meeting_bots[1]?.recallRecordingId).toBe("rec_1");
		expect(rows.meeting_bots[1]?.statusSubCode).toBeNull();
	});
});
