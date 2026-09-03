import type { Organisation, User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sharePrimaryRecordingWithOrganization } from "@/lib/recall/shared-recording";

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
			"orgId",
			"ownerId",
			"statusSubCode",
			"videoId",
		]),
		sharedVideos: table("shared_videos", [
			"id",
			"videoId",
			"organizationId",
			"sharedByUserId",
			"folderId",
		]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
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
const videoId = "video_1" as Video.VideoId;
const meetingBotId = "primary_1";

let rows: Record<string, Row[]>;
let insertShouldFail = false;

function matches(row: Row, condition?: Condition): boolean {
	if (!condition) return true;
	if (condition.op === "and") {
		return (condition.args ?? []).every((part) => matches(row, part));
	}
	const key = condition.column?.split(".")[1] ?? "";
	const value = row[key];
	if (condition.op === "eq") return value === condition.value;
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
				limit: async (limit: number) => run().slice(0, limit),
			};
			return query;
		},
		insert(table: Table) {
			return {
				values: async (values: Row) => {
					if (insertShouldFail) {
						throw new Error("insert failed");
					}
					const tableRows = rows[table.table];
					const next = { folderId: null, ...values };
					if (tableRows) tableRows.push(next);
					else rows[table.table] = [next];
					return [{ affectedRows: 1 }];
				},
			};
		},
	};
}

beforeEach(() => {
	insertShouldFail = false;
	rows = {
		meeting_bots: [
			{
				id: meetingBotId,
				orgId,
				ownerId,
				statusSubCode: null,
				videoId,
			},
			{
				id: "shared_1",
				orgId,
				ownerId: "user_2",
				statusSubCode: `shared:${meetingBotId}`,
				videoId,
			},
		],
		shared_videos: [],
	};
	mocks.db.mockReturnValue(createClient());
});

describe("sharePrimaryRecordingWithOrganization", () => {
	it("inserts one org-level sharedVideos row for the primary recording", async () => {
		await sharePrimaryRecordingWithOrganization({ meetingBotId, videoId });

		expect(rows.shared_videos).toHaveLength(1);
		expect(rows.shared_videos?.[0]).toMatchObject({
			videoId,
			organizationId: orgId,
			sharedByUserId: ownerId,
		});
	});

	it("is idempotent when the org share already exists", async () => {
		rows.shared_videos = [
			{
				id: "share_existing",
				videoId,
				organizationId: orgId,
				sharedByUserId: ownerId,
			},
		];

		await sharePrimaryRecordingWithOrganization({ meetingBotId, videoId });

		expect(rows.shared_videos).toHaveLength(1);
		expect(rows.shared_videos?.[0]?.id).toBe("share_existing");
	});

	it("does nothing when no rows share the primary bot", async () => {
		rows.meeting_bots = [
			{
				id: meetingBotId,
				orgId,
				ownerId,
				statusSubCode: null,
				videoId,
			},
		];

		await sharePrimaryRecordingWithOrganization({ meetingBotId, videoId });

		expect(rows.shared_videos).toHaveLength(0);
	});

	it("does not throw when the share insert fails", async () => {
		insertShouldFail = true;

		await expect(
			sharePrimaryRecordingWithOrganization({ meetingBotId, videoId }),
		).resolves.toBeUndefined();
		expect(rows.shared_videos).toHaveLength(0);
	});
});
