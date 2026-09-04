import type { Organisation, User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecallClient } from "@/lib/recall/client";
import {
	canUserAccessMeetingBot,
	meetingSpaceName,
	meetingVideoIsPublic,
	migrateMeetingSpacesToVideoShares,
	shareMeetingRecordingWithAttendees,
} from "@/lib/recall/visibility";

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
			"title",
			"joinAt",
			"videoId",
			"calendarEventId",
			"recallBotId",
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
		videos: table("videos", ["id", "ownerId", "public"]),
		videoShares: table("video_shares", [
			"videoId",
			"userId",
			"sharedByUserId",
			"source",
			"createdAt",
		]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
	inArray: (column: string, values: unknown[]) => ({
		op: "inArray",
		column,
		values,
	}),
	isNotNull: (column: string) => ({ op: "isNotNull", column }),
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
	values?: unknown[];
};

const orgId = "org_1" as Organisation.OrganisationId;
const ownerId = "user_1" as User.UserId;
const sharedOwnerId = "user_2" as User.UserId;
const calendarUserId = "user_3" as User.UserId;
const strangerId = "user_4" as User.UserId;
const shareOnlyId = "user_5" as User.UserId;
const videoId = "video_1" as Video.VideoId;
const meetingBotId = "primary_1";
const spaceId = "space_1";
const joinAt = new Date("2026-09-03T16:00:00.000Z");

let rows: Record<string, Row[]>;

function matches(row: Row, condition?: Condition): boolean {
	if (!condition) return true;
	if (condition.op === "and") {
		return (condition.args ?? []).every((part) => matches(row, part));
	}
	const key = condition.column?.split(".")[1] ?? "";
	if (condition.op === "eq") return row[key] === condition.value;
	if (condition.op === "inArray") {
		return (condition.values ?? []).includes(row[key]);
	}
	if (condition.op === "isNotNull") return row[key] != null;
	throw new Error(`Unexpected condition ${condition.op}`);
}

function createClient() {
	return {
		select() {
			let table = "";
			const joins: string[] = [];
			let condition: Condition | undefined;
			const run = () => {
				if (table === "users" && joins.includes("organization_members")) {
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
				if (
					table === "space_videos" &&
					joins.includes("meeting_bots") &&
					joins.includes("spaces") &&
					joins.includes("videos")
				) {
					return (rows.space_videos ?? []).flatMap((spaceVideo) => {
						const space = (rows.spaces ?? []).find(
							(row) => row.id === spaceVideo.spaceId,
						);
						const video = (rows.videos ?? []).find(
							(row) => row.id === spaceVideo.videoId,
						);
						if (!space || !video) return [];
						return (rows.meeting_bots ?? [])
							.filter((bot) => bot.videoId === spaceVideo.videoId)
							.map((bot) => {
								const joined = {
									spaceId: space.id,
									spaceName: space.name,
									privacy: space.privacy,
									public: space.public,
									videoId: spaceVideo.videoId,
									ownerId: video.ownerId,
									title: bot.title,
									joinAt: bot.joinAt,
									meetingBotId: bot.id,
									statusSubCode: bot.statusSubCode,
								};
								return matches(joined, condition) ? joined : null;
							})
							.filter((row): row is NonNullable<typeof row> => row !== null);
					});
				}
				if (table === "meeting_bots" && joins.includes("videos")) {
					return (rows.meeting_bots ?? []).flatMap((bot) => {
						const video = (rows.videos ?? []).find(
							(row) => row.id === bot.videoId,
						);
						if (!video) return [];
						const joined = {
							videoId: bot.videoId,
							ownerId: video.ownerId,
							meetingBotId: bot.id,
							statusSubCode: bot.statusSubCode,
							public: video.public,
						};
						return matches(joined, condition) ? [joined] : [];
					});
				}
				return (rows[table] ?? []).filter((row) => matches(row, condition));
			};
			const query = {
				from(value: Table) {
					table = value.table;
					return query;
				},
				innerJoin(value: Table) {
					joins.push(value.table);
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
			const apply = async (values: Row | Row[]) => {
				const tableRows = rows[table.table] ?? [];
				const next = Array.isArray(values) ? values : [values];
				for (const value of next) {
					if (table.table === "video_shares") {
						const exists = tableRows.some(
							(row) =>
								row.videoId === value.videoId && row.userId === value.userId,
						);
						if (exists) continue;
					}
					tableRows.push(value);
				}
				rows[table.table] = tableRows;
				return [{ affectedRows: next.length }];
			};
			return {
				values: apply,
				ignore() {
					return { values: apply };
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

function seedMeeting() {
	rows = {
		meeting_bots: [
			{
				id: meetingBotId,
				orgId,
				ownerId,
				title: "Standup",
				joinAt,
				videoId,
				calendarEventId: "evt_1",
				recallBotId: "recall_1",
				statusSubCode: null,
			},
			{
				id: "shared_1",
				orgId,
				ownerId: sharedOwnerId,
				title: "Standup",
				joinAt,
				videoId,
				calendarEventId: "evt_1",
				recallBotId: "recall_1",
				statusSubCode: `shared:${meetingBotId}`,
			},
		],
		users: [
			{ id: ownerId, email: "Ada@example.com" },
			{ id: sharedOwnerId, email: "cam@example.com" },
			{ id: calendarUserId, email: "Bea@example.com" },
			{ id: strangerId, email: "dan@example.com" },
			{ id: shareOnlyId, email: "erin@example.com" },
			{ id: "outsider", email: "zoe@example.com" },
		],
		organization_members: [
			{ userId: ownerId, organizationId: orgId },
			{ userId: sharedOwnerId, organizationId: orgId },
			{ userId: calendarUserId, organizationId: orgId },
			{ userId: strangerId, organizationId: orgId },
			{ userId: shareOnlyId, organizationId: orgId },
		],
		spaces: [],
		space_members: [],
		space_videos: [],
		videos: [{ id: videoId, ownerId, public: false }],
		video_shares: [],
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
	seedMeeting();
});

describe("canUserAccessMeetingBot", () => {
	it("allows the bot owner", async () => {
		await expect(canUserAccessMeetingBot(meetingBotId, ownerId)).resolves.toBe(
			true,
		);
	});

	it("allows a user who owns a shared recording row", async () => {
		await expect(
			canUserAccessMeetingBot(meetingBotId, sharedOwnerId),
		).resolves.toBe(true);
	});

	it("allows a calendar attendee matched by email", async () => {
		const client = mockClient();
		await expect(
			canUserAccessMeetingBot(meetingBotId, calendarUserId, { client }),
		).resolves.toBe(true);
	});

	it("allows a user with a video_shares row", async () => {
		rows.video_shares = [
			{
				videoId,
				userId: shareOnlyId,
				sharedByUserId: ownerId,
				source: "manual",
			},
		];
		await expect(
			canUserAccessMeetingBot(meetingBotId, shareOnlyId),
		).resolves.toBe(true);
	});

	it("denies a stranger", async () => {
		const client = mockClient();
		await expect(
			canUserAccessMeetingBot(meetingBotId, strangerId, { client }),
		).resolves.toBe(false);
	});
});

describe("meeting visibility", () => {
	it("creates meeting videos as private", () => {
		expect(meetingVideoIsPublic()).toBe(false);
	});

	it("inserts video_shares for shared-row owners and calendar org members", async () => {
		const client = mockClient();
		await shareMeetingRecordingWithAttendees(meetingBotId, { client });

		expect(rows.spaces).toHaveLength(0);
		expect(rows.space_videos).toHaveLength(0);
		expect(rows.space_members).toHaveLength(0);
		const shares = rows.video_shares ?? [];
		expect(shares).toHaveLength(2);
		expect(shares).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					videoId,
					userId: sharedOwnerId,
					sharedByUserId: ownerId,
					source: "meeting",
				}),
				expect.objectContaining({
					videoId,
					userId: calendarUserId,
					sharedByUserId: ownerId,
					source: "meeting",
				}),
			]),
		);
		expect(shares.map((row) => row.userId)).not.toContain(ownerId);
		expect(shares.map((row) => row.userId)).not.toContain("outsider");
	});

	it("is idempotent and never inserts an org-wide sharedVideos row", async () => {
		const client = mockClient();
		await shareMeetingRecordingWithAttendees(meetingBotId, { client });
		await shareMeetingRecordingWithAttendees(meetingBotId, { client });

		expect(rows.video_shares).toHaveLength(2);
		expect(rows.spaces).toHaveLength(0);
		expect(rows).not.toHaveProperty("shared_videos");
	});
});

describe("migrateMeetingSpacesToVideoShares", () => {
	it("copies auto-created meeting space members into video_shares and deletes the space", async () => {
		rows.spaces = [
			{
				id: spaceId,
				name: meetingSpaceName("Standup", joinAt),
				organizationId: orgId,
				createdById: ownerId,
				privacy: "Private",
				public: false,
			},
		];
		rows.space_videos = [{ id: "sv_1", spaceId, videoId, addedById: ownerId }];
		rows.space_members = [
			{ id: "sm_1", spaceId, userId: ownerId, role: "admin" },
			{ id: "sm_2", spaceId, userId: sharedOwnerId, role: "member" },
			{ id: "sm_3", spaceId, userId: calendarUserId, role: "member" },
		];
		rows.videos = [{ id: videoId, ownerId, public: true }];

		const client = mockClient();
		const result = await migrateMeetingSpacesToVideoShares({ client });

		expect(result.spacesMigrated).toBe(1);
		expect(result.videosPrivatized).toBe(1);
		expect(rows.spaces).toHaveLength(0);
		expect(rows.space_videos).toHaveLength(0);
		expect(rows.space_members).toHaveLength(0);
		expect(rows.videos[0]?.public).toBe(false);
		const shareIds = (rows.video_shares ?? []).map((row) => row.userId).sort();
		expect(shareIds).toEqual([sharedOwnerId, calendarUserId].sort());
		expect(shareIds).not.toContain(ownerId);
	});

	it("is a no-op once meeting spaces and public meeting videos are gone", async () => {
		const client = mockClient();
		const result = await migrateMeetingSpacesToVideoShares({ client });
		expect(result).toEqual({ spacesMigrated: 0, videosPrivatized: 0 });
		expect(rows.video_shares).toHaveLength(0);
	});

	it("leaves a differently named private space untouched", async () => {
		rows.spaces = [
			{
				id: spaceId,
				name: "Team recordings",
				organizationId: orgId,
				createdById: ownerId,
				privacy: "Private",
				public: false,
			},
		];
		rows.space_videos = [{ id: "sv_1", spaceId, videoId, addedById: ownerId }];
		rows.space_members = [
			{ id: "sm_1", spaceId, userId: ownerId, role: "admin" },
			{ id: "sm_2", spaceId, userId: sharedOwnerId, role: "member" },
		];

		const client = mockClient();
		const result = await migrateMeetingSpacesToVideoShares({ client });

		expect(result.spacesMigrated).toBe(0);
		expect(rows.spaces).toHaveLength(1);
		expect(rows.space_videos).toHaveLength(1);
		expect(rows.space_members).toHaveLength(2);
	});

	it("privatizes public meeting videos and writes attendee shares", async () => {
		rows.videos = [{ id: videoId, ownerId, public: true }];
		const client = mockClient();
		const result = await migrateMeetingSpacesToVideoShares({ client });

		expect(result.spacesMigrated).toBe(0);
		expect(result.videosPrivatized).toBe(1);
		expect(rows.videos[0]?.public).toBe(false);
		const shareIds = (rows.video_shares ?? []).map((row) => row.userId).sort();
		expect(shareIds).toEqual([sharedOwnerId, calendarUserId].sort());
	});
});
