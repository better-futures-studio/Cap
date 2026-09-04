import type { Organisation, User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecallClient } from "@/lib/recall/client";
import {
	meetingVideoIsPublic,
	shareMeetingRecordingWithAttendees,
} from "@/lib/recall/visibility";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	nanoId: vi.fn(() => "id_1"),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/helpers", () => ({ nanoId: mocks.nanoId }));
vi.mock("@cap/database/schema", () => {
	const table = (name: string, fields: string[]) =>
		Object.fromEntries([
			["table", name],
			...fields.map((field) => [field, `${name}.${field}`]),
		]);
	return {
		meetingBots: table("meeting_bots", [
			"id",
			"orgId",
			"ownerId",
			"title",
			"joinAt",
			"videoId",
			"calendarEventId",
			"statusSubCode",
		]),
		users: table("users", ["id", "email"]),
		organizationMembers: table("organization_members", [
			"userId",
			"organizationId",
		]),
		spaces: table("spaces", [
			"id",
			"name",
			"organizationId",
			"createdById",
			"privacy",
			"public",
		]),
		spaceMembers: table("space_members", ["id", "spaceId", "userId", "role"]),
		spaceVideos: table("space_videos", [
			"id",
			"spaceId",
			"videoId",
			"addedById",
		]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
}));
vi.mock("@/lib/recall/config", () => ({
	DEFAULT_BOT_NAME: "Meeting Notetaker",
	getRecallConfig: () => ({ botName: "Meeting Notetaker" }),
}));
vi.mock("@/lib/recall/default-client", () => ({
	getDefaultRecallClient: () => {
		throw new Error("default Recall client should not be used in tests");
	},
}));

type Row = Record<string, unknown>;
type Table = { table: string };
type Condition = {
	op: string;
	args?: (Condition | undefined)[];
	column?: string;
	value?: unknown;
};

const orgId = "org_1" as Organisation.OrganisationId;
const ownerId = "user_1" as User.UserId;
const sharedOwnerId = "user_2" as User.UserId;
const calendarUserId = "user_3" as User.UserId;
const videoId = "video_1" as Video.VideoId;
const meetingBotId = "primary_1";

let rows: Record<string, Row[]>;
let nanoIdCount = 0;

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
			let joinTable = "";
			let condition: Condition | undefined;
			const run = () => {
				if (table === "users" && joinTable === "organization_members") {
					const org = condition?.value ?? orgId;
					const memberIds = new Set(
						(rows.organization_members ?? [])
							.filter((row) => row.organizationId === org)
							.map((row) => row.userId),
					);
					return (rows.users ?? [])
						.filter((row) => memberIds.has(row.id))
						.map((row) => ({ userId: row.id, email: row.email }));
				}
				return (rows[table] ?? []).filter((row) => matches(row, condition));
			};
			const query = {
				from(value: Table) {
					table = value.table;
					return query;
				},
				innerJoin(value: Table) {
					joinTable = value.table;
					return query;
				},
				where(value: Condition) {
					condition = value;
					return query;
				},
				limit: async (limit: number) => run().slice(0, limit),
			};
			return query;
		},
		insert(table: Table) {
			return {
				values: async (values: Row | Row[]) => {
					const tableRows = rows[table.table] ?? [];
					const next = Array.isArray(values) ? values : [values];
					tableRows.push(...next);
					rows[table.table] = tableRows;
					return [{ affectedRows: next.length }];
				},
			};
		},
	};
}

function seedMeeting() {
	rows = {
		meeting_bots: [
			{
				id: meetingBotId,
				orgId,
				ownerId,
				title: "Standup",
				joinAt: new Date("2026-09-03T16:00:00.000Z"),
				videoId,
				calendarEventId: "evt_1",
				statusSubCode: null,
			},
			{
				id: "shared_1",
				orgId,
				ownerId: sharedOwnerId,
				title: "Standup",
				joinAt: new Date("2026-09-03T16:00:00.000Z"),
				videoId,
				calendarEventId: "evt_1",
				statusSubCode: `shared:${meetingBotId}`,
			},
		],
		users: [
			{ id: ownerId, email: "Ada@example.com" },
			{ id: sharedOwnerId, email: "cam@example.com" },
			{ id: calendarUserId, email: "Bea@example.com" },
			{ id: "outsider", email: "zoe@example.com" },
		],
		organization_members: [
			{ userId: ownerId, organizationId: orgId },
			{ userId: sharedOwnerId, organizationId: orgId },
			{ userId: calendarUserId, organizationId: orgId },
		],
		spaces: [],
		space_members: [],
		space_videos: [],
	};
	mocks.db.mockReturnValue(createClient());
}

function mockClient(): RecallClient {
	return {
		getCalendarEvent: vi.fn(async () => ({
			id: "evt_1",
			raw: {
				attendees: [
					{ email: "ada@example.com" },
					{ email: "bea@example.com" },
					{ email: "room@resource.calendar.google.com", resource: true },
					{ email: "zoe@example.com" },
				],
			},
		})),
	} as unknown as RecallClient;
}

beforeEach(() => {
	nanoIdCount = 0;
	mocks.nanoId.mockImplementation(() => {
		nanoIdCount += 1;
		return `id_${nanoIdCount}`;
	});
	seedMeeting();
});

describe("meeting visibility", () => {
	it("creates meeting videos as private", () => {
		expect(meetingVideoIsPublic()).toBe(false);
	});

	it("grants a private space to shared-row owners and calendar org members", async () => {
		const client = mockClient();
		await shareMeetingRecordingWithAttendees(meetingBotId, { client });

		const createdSpaces = rows.spaces ?? [];
		const createdVideos = rows.space_videos ?? [];
		const createdMembers = rows.space_members ?? [];
		expect(createdSpaces).toHaveLength(1);
		expect(createdSpaces[0]).toMatchObject({
			name: "Standup",
			organizationId: orgId,
			createdById: ownerId,
			privacy: "Private",
			public: false,
		});
		expect(createdVideos).toHaveLength(1);
		expect(createdVideos[0]).toMatchObject({
			videoId,
			addedById: ownerId,
		});
		const memberIds = createdMembers.map((row) => row.userId).sort();
		expect(memberIds).toEqual([ownerId, sharedOwnerId, calendarUserId].sort());
		expect(memberIds).not.toContain("outsider");
	});

	it("is idempotent and never inserts an org-wide sharedVideos row", async () => {
		const client = mockClient();
		await shareMeetingRecordingWithAttendees(meetingBotId, { client });
		await shareMeetingRecordingWithAttendees(meetingBotId, { client });

		expect(rows.spaces).toHaveLength(1);
		expect(rows.space_videos).toHaveLength(1);
		expect(rows.space_members).toHaveLength(3);
		expect(rows).not.toHaveProperty("shared_videos");
	});
});
