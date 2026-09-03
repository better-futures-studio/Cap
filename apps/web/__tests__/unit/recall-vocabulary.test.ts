import type { Organisation, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getCurrentUser: vi.fn(),
	requireOrganizationAccess: vi.fn(),
	nanoId: vi.fn(() => "vocab_1"),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/database/helpers", () => ({ nanoId: mocks.nanoId }));
vi.mock("@cap/database/schema", () => {
	const table = (name: string, fields: string[]) =>
		Object.fromEntries([
			["table", name],
			...fields.map((field) => [field, `${name}.${field}`]),
		]);
	return {
		meetingBots: table("meeting_bots", ["id", "orgId"]),
		videoUploads: table("video_uploads", ["videoId"]),
		slackHuddleTeams: table("slack_huddle_teams", ["id", "orgId"]),
		meetingPreferences: table("meeting_preferences", ["userId", "recapMode"]),
		meetingVocabulary: table("meeting_vocabulary", [
			"id",
			"orgId",
			"term",
			"spelling",
			"createdAt",
		]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
	or: (...args: unknown[]) => ({ op: "or", args }),
	inArray: (column: string, values: unknown[]) => ({
		op: "inArray",
		column,
		values,
	}),
	gte: (column: string, value: unknown) => ({ op: "gte", column, value }),
	lt: (column: string, value: unknown) => ({ op: "lt", column, value }),
	asc: (column: string) => column,
	desc: (column: string) => column,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationAccess: mocks.requireOrganizationAccess,
}));
vi.mock("@/lib/recall/config", () => ({
	isRecallConfigured: () => true,
	isRecallCalendarConfigured: () => true,
}));
vi.mock("@/lib/recall/bots", () => ({
	parseMeetingUrl: vi.fn(),
	scheduleManualMeetingBot: vi.fn(),
	cancelMeetingBot: vi.fn(),
}));
vi.mock("@/lib/recall/calendars", () => ({
	getUserCalendar: vi.fn(),
	listUpcomingCalendarEvents: vi.fn(),
	setCalendarAutoRecord: vi.fn(),
	toggleCalendarEventRecording: vi.fn(),
	disconnectCalendar: vi.fn(),
	setCalendarSeriesRule: vi.fn(),
}));
vi.mock("@/lib/recall/action-items", () => ({
	getMeetingActionItems: vi.fn(),
}));
vi.mock("@/lib/recall/speaker-stats", () => ({
	getMeetingSpeakerStats: vi.fn(),
}));
vi.mock("@/lib/recall/recap", () => ({
	parseRecapMode: (value: unknown) =>
		value === "off" || value === "self" || value === "attendees"
			? value
			: "self",
}));

const { addMeetingVocabulary, listMeetingVocabulary, removeMeetingVocabulary } =
	await import("@/actions/meetings");

type Row = Record<string, unknown>;
type Table = { table: string };
type Condition = {
	op: string;
	args?: (Condition | undefined)[];
	column?: string;
	value?: unknown;
};

const orgId = "org_1" as Organisation.OrganisationId;
const userId = "user_1" as User.UserId;

let rows: Record<string, Row[]>;

function matches(row: Row, condition?: Condition): boolean {
	if (!condition) return true;
	if (condition.op === "and") {
		return (condition.args ?? []).every((part) => matches(row, part));
	}
	const key = condition.column?.split(".")[1] ?? "";
	if (condition.op === "eq") return row[key] === condition.value;
	throw new Error(`Unexpected condition ${condition.op}`);
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
					return query;
				},
				where(value: Condition) {
					condition = value;
					return query;
				},
				orderBy: async () => run(),
				limit: async (limit: number) => run().slice(0, limit),
			};
			return query;
		},
		insert(table: Table) {
			return {
				values: async (values: Row) => {
					const tableRows = rows[table.table] ?? [];
					tableRows.push(values);
					rows[table.table] = tableRows;
					return [{ affectedRows: 1 }];
				},
			};
		},
		update(table: Table) {
			return {
				set(values: Row) {
					return {
						where: async (condition: Condition) => {
							const matching = (rows[table.table] ?? []).filter((row) =>
								matches(row, condition),
							);
							for (const row of matching) Object.assign(row, values);
							return [{ affectedRows: matching.length }];
						},
					};
				},
			};
		},
		delete(table: Table) {
			return {
				where: async (condition: Condition) => {
					rows[table.table] = (rows[table.table] ?? []).filter(
						(row) => !matches(row, condition),
					);
				},
			};
		},
	};
}

beforeEach(() => {
	rows = { meeting_vocabulary: [] };
	mocks.db.mockReturnValue(createClient());
	mocks.getCurrentUser.mockResolvedValue({ id: userId });
	mocks.requireOrganizationAccess.mockResolvedValue({ id: orgId });
	mocks.nanoId.mockReturnValue("vocab_1");
});

describe("meeting vocabulary actions", () => {
	it("lists terms for the org", async () => {
		rows.meeting_vocabulary = [
			{
				id: "v1",
				orgId,
				term: "Boca",
				spelling: "Boca Pro",
				createdAt: new Date("2026-09-03T00:00:00.000Z"),
			},
		];

		await expect(listMeetingVocabulary({ orgId })).resolves.toEqual(
			rows.meeting_vocabulary,
		);
	});

	it("inserts a new term and upserts spelling on the same term", async () => {
		const created = await addMeetingVocabulary({
			orgId,
			term: "  Cap  ",
			spelling: "Cap",
		});
		expect(created).toMatchObject({
			id: "vocab_1",
			orgId,
			term: "Cap",
			spelling: "Cap",
		});
		expect(rows.meeting_vocabulary).toHaveLength(1);

		const updated = await addMeetingVocabulary({
			orgId,
			term: "Cap",
			spelling: "Cap.so",
		});
		expect(updated.spelling).toBe("Cap.so");
		const vocabulary = rows.meeting_vocabulary ?? [];
		expect(vocabulary).toHaveLength(1);
		expect(vocabulary[0]?.spelling).toBe("Cap.so");
	});

	it("removes a term by id", async () => {
		rows.meeting_vocabulary = [
			{
				id: "vocab_1",
				orgId,
				term: "Cap",
				spelling: null,
				createdAt: new Date(),
			},
		];

		await removeMeetingVocabulary({ orgId, id: "vocab_1" });
		expect(rows.meeting_vocabulary).toHaveLength(0);
	});
});
