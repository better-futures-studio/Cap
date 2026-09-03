import type { Organisation, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyBotStatusEvent,
	parseMeetingUrl,
	scheduleManualMeetingBot,
} from "@/lib/recall/bots";
import { RecallApiError, type RecallClient } from "@/lib/recall/client";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getUserCalendar: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@/lib/recall/calendars", () => ({
	getUserCalendar: mocks.getUserCalendar,
}));
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
			"source",
			"meetingUrl",
			"title",
			"joinAt",
			"endAt",
			"calendarId",
			"calendarEventId",
			"recallBotId",
			"recallRecordingId",
			"recallTranscriptId",
			"status",
			"statusSubCode",
			"statusUpdatedAt",
			"errorMessage",
			"videoId",
			"chatSyncedAt",
			"createdAt",
			"updatedAt",
			"slackTeamId",
			"slackChannelId",
		]),
		slackHuddleTeams: table("slack_huddle_teams", [
			"id",
			"orgId",
			"recallSlackTeamId",
			"botName",
			"status",
			"workspaceName",
		]),
		organizations: table("organizations", ["id", "ownerId"]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
	inArray: (column: string, value: unknown[]) => ({ op: "in", column, value }),
	lt: (column: string, value: unknown) => ({ op: "lt", column, value }),
	or: (...args: unknown[]) => ({ op: "or", args }),
	isNull: (column: string) => ({ op: "isNull", column }),
}));
vi.mock("@/lib/recall/config", () => ({
	getRecallConfig: () => null,
	isRecallConfigured: () => false,
}));
vi.mock("@/lib/recall/bot-image", () => ({
	loadBotVideoOutput: vi.fn(async () => null),
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
const userId = "user_1" as User.UserId;
const now = new Date("2026-09-03T16:00:00.000Z");

let rows: Record<string, Row[]>;

function bots(): Row[] {
	const list = rows.meeting_bots;
	if (!list) throw new Error("expected meeting_bots rows");
	return list;
}

function matches(row: Row, condition?: Condition): boolean {
	if (!condition) return true;
	if (condition.op === "and") {
		return (condition.args ?? []).every((part) => matches(row, part));
	}
	if (condition.op === "or") {
		return (condition.args ?? []).some((part) => matches(row, part));
	}
	const key = condition.column?.split(".")[1] ?? "";
	const value = row[key];
	if (condition.op === "isNull") return value === null || value === undefined;
	if (condition.op === "eq") return value === condition.value;
	if (condition.op === "in") {
		return Array.isArray(condition.value) && condition.value.includes(value);
	}
	if (condition.op === "lt") {
		const left = value instanceof Date ? value.getTime() : Number(value);
		const right =
			condition.value instanceof Date
				? condition.value.getTime()
				: Number(condition.value);
		return left < right;
	}
	throw new Error(`Unexpected condition ${condition.op}`);
}

function createClient() {
	const client = {
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
					const tableRows = rows[table.table];
					const next = {
						title: null,
						recallBotId: null,
						statusSubCode: null,
						errorMessage: null,
						createdAt: now,
						updatedAt: now,
						...values,
					};
					if (tableRows) tableRows.push(next);
					else rows[table.table] = [next];
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
	};
	return client;
}

function mockClient(overrides: Partial<RecallClient> = {}): RecallClient {
	return {
		createBot: vi.fn(async () => ({ id: "bot_1" })),
		...overrides,
	} as RecallClient;
}

beforeEach(() => {
	rows = { meeting_bots: [] };
	mocks.db.mockReturnValue(createClient());
	mocks.getUserCalendar.mockReset().mockResolvedValue(null);
});

describe("parseMeetingUrl", () => {
	it("accepts Zoom, Google Meet, and Teams hosts", () => {
		expect(parseMeetingUrl("https://zoom.us/j/123")).toEqual({
			url: "https://zoom.us/j/123",
			platform: "zoom",
		});
		expect(parseMeetingUrl("https://us05web.zoom.us/j/123")).toEqual({
			url: "https://us05web.zoom.us/j/123",
			platform: "zoom",
		});
		expect(parseMeetingUrl("https://meet.google.com/abc-defg-hij")).toEqual({
			url: "https://meet.google.com/abc-defg-hij",
			platform: "google_meet",
		});
		expect(
			parseMeetingUrl("https://teams.microsoft.com/l/meetup-join/19:meeting"),
		).toEqual({
			url: "https://teams.microsoft.com/l/meetup-join/19:meeting",
			platform: "microsoft_teams",
		});
		expect(parseMeetingUrl("https://teams.live.com/meet/123")).toEqual({
			url: "https://teams.live.com/meet/123",
			platform: "microsoft_teams",
		});
		expect(parseMeetingUrl("zoom.us/j/123")?.platform).toBe("zoom");
	});

	it("rejects unsupported hosts", () => {
		expect(parseMeetingUrl("https://example.com/meet")).toBeNull();
		expect(parseMeetingUrl("not a url")).toBeNull();
		expect(parseMeetingUrl("")).toBeNull();
	});
});

describe("scheduleManualMeetingBot", () => {
	it("persists intent before createBot and stores the bot id", async () => {
		const client = mockClient({
			createBot: vi.fn(async () => {
				expect(bots()).toHaveLength(1);
				expect(bots()[0]?.status).toBe("scheduling");
				expect(bots()[0]?.recallBotId).toBeNull();
				return { id: "bot_1" };
			}),
		});

		const result = await scheduleManualMeetingBot(
			{
				orgId,
				userId,
				meetingUrl: "https://zoom.us/j/123",
				title: "Standup",
			},
			{ client, now: () => now },
		);

		expect(result).toEqual({
			id: bots()[0]?.id,
			status: "scheduled",
		});
		expect(client.createBot).toHaveBeenCalledOnce();
		expect(client.createBot).toHaveBeenCalledWith({
			meetingUrl: "https://zoom.us/j/123",
			joinAt: now.toISOString(),
			botName: "Boca Pro Notetaker",
			metadata: {
				cap_meeting_bot_id: result.id,
				cap_org_id: orgId,
			},
			joinChatMessage: "Boca Pro Notetaker is recording this meeting.",
		});
		expect(bots()[0]).toMatchObject({
			status: "scheduled",
			recallBotId: "bot_1",
			source: "manual",
			ownerId: userId,
			orgId,
			title: "Standup",
		});
	});

	it("marks the row failed when Recall rejects createBot", async () => {
		const client = mockClient({
			createBot: vi.fn(async () => {
				throw new RecallApiError(400, "Recall API request failed (400)", null);
			}),
		});

		const result = await scheduleManualMeetingBot(
			{ orgId, userId, meetingUrl: "https://meet.google.com/abc-defg-hij" },
			{ client, now: () => now },
		);

		expect(result.status).toBe("failed");
		expect(bots()[0]).toMatchObject({
			status: "failed",
			errorMessage: "Recall rejected the request (HTTP 400)",
		});
	});

	it("uses a matching calendar event title when none is given", async () => {
		mocks.getUserCalendar.mockResolvedValue({
			id: "cal_1",
			recallCalendarId: "recall_cal",
			status: "connected",
		});
		const client = mockClient({
			listCalendarEvents: vi.fn(async () => [
				{
					id: "evt_1",
					meeting_url: "https://Meet.Google.com/abc-defg-hij/?authuser=1",
					raw: { summary: "Weekly standup" },
				},
			]) as unknown as RecallClient["listCalendarEvents"],
		});

		const result = await scheduleManualMeetingBot(
			{
				orgId,
				userId,
				meetingUrl: "https://meet.google.com/abc-defg-hij",
			},
			{ client, now: () => now },
		);

		expect(result.status).toBe("scheduled");
		expect(bots()[0]).toMatchObject({
			title: "Weekly standup",
			calendarEventId: "evt_1",
		});
	});

	it("leaves calendarEventId null when that event already has a row", async () => {
		rows.meeting_bots = [
			{
				id: "existing_cal",
				calendarEventId: "evt_1",
				status: "complete",
				joinAt: now,
			},
		];
		mocks.getUserCalendar.mockResolvedValue({
			id: "cal_1",
			recallCalendarId: "recall_cal",
			status: "connected",
		});
		const client = mockClient({
			listCalendarEvents: vi.fn(async () => [
				{
					id: "evt_1",
					meeting_url: "https://meet.google.com/abc-defg-hij",
					raw: { summary: "Weekly standup" },
				},
			]) as unknown as RecallClient["listCalendarEvents"],
		});

		const result = await scheduleManualMeetingBot(
			{
				orgId,
				userId,
				meetingUrl: "https://meet.google.com/abc-defg-hij",
			},
			{ client, now: () => now },
		);

		expect(result.status).toBe("scheduled");
		expect(bots()[1]).toMatchObject({
			title: "Weekly standup",
			calendarEventId: null,
		});
	});

	it("returns an existing in-flight bot instead of creating another", async () => {
		rows.meeting_bots = [
			{
				id: "existing",
				orgId,
				ownerId: userId,
				source: "manual",
				meetingUrl: "https://zoom.us/j/123",
				status: "scheduled",
				joinAt: now,
				recallBotId: "bot_existing",
			},
		];
		const client = mockClient();

		const result = await scheduleManualMeetingBot(
			{ orgId, userId, meetingUrl: "https://zoom.us/j/123" },
			{ client, now: () => now },
		);

		expect(result).toEqual({ id: "existing", status: "scheduled" });
		expect(client.createBot).not.toHaveBeenCalled();
		expect(bots()).toHaveLength(1);
	});
});

describe("applyBotStatusEvent", () => {
	it("maps Recall codes onto non-terminal rows", async () => {
		rows.meeting_bots = [
			{
				id: "mb_1",
				recallBotId: "bot_1",
				status: "scheduled",
				statusSubCode: null,
				errorMessage: null,
			},
			{
				id: "mb_2",
				recallBotId: "bot_1",
				status: "scheduled",
				statusSubCode: null,
				errorMessage: null,
			},
		];

		await applyBotStatusEvent({
			recallBotId: "bot_1",
			code: "in_call_recording",
			subCode: null,
		});

		expect(bots()[0]?.status).toBe("in_call_recording");
		expect(bots()[1]?.status).toBe("in_call_recording");
	});

	it("keeps the newest event when webhooks arrive out of order", async () => {
		rows.meeting_bots = [
			{
				id: "mb_1",
				recallBotId: "bot_1",
				status: "scheduled",
				statusSubCode: null,
				statusUpdatedAt: null,
				errorMessage: null,
			},
		];

		await applyBotStatusEvent({
			recallBotId: "bot_1",
			code: "in_call_recording",
			updatedAt: "2026-09-03T19:40:52.500Z",
		});
		await applyBotStatusEvent({
			recallBotId: "bot_1",
			code: "in_call_not_recording",
			updatedAt: "2026-09-03T19:40:51.000Z",
		});

		expect(bots()[0]).toMatchObject({
			status: "in_call_recording",
			statusUpdatedAt: new Date("2026-09-03T19:40:52.500Z"),
		});
	});

	it("sets fatal errorMessage from the subCode", async () => {
		rows.meeting_bots = [
			{
				id: "mb_1",
				recallBotId: "bot_1",
				status: "joining_call",
				statusSubCode: null,
				errorMessage: null,
			},
		];

		await applyBotStatusEvent({
			recallBotId: "bot_1",
			code: "fatal",
			subCode: "bot_errored",
		});

		expect(bots()[0]).toMatchObject({
			status: "fatal",
			statusSubCode: "bot_errored",
			errorMessage: "bot_errored",
		});
	});

	it("ignores terminal rows and rows already past done", async () => {
		rows.meeting_bots = [
			{ id: "done", recallBotId: "bot_1", status: "complete" },
			{ id: "fail", recallBotId: "bot_1", status: "failed" },
			{ id: "import", recallBotId: "bot_1", status: "importing" },
			{ id: "live", recallBotId: "bot_1", status: "scheduled" },
		];

		await applyBotStatusEvent({
			recallBotId: "bot_1",
			code: "call_ended",
		});

		expect(bots().map((row) => row.status)).toEqual([
			"complete",
			"failed",
			"importing",
			"call_ended",
		]);
	});

	it("ignores unknown codes", async () => {
		rows.meeting_bots = [
			{ id: "mb_1", recallBotId: "bot_1", status: "scheduled" },
		];

		await applyBotStatusEvent({
			recallBotId: "bot_1",
			code: "analysis_done",
		});

		expect(bots()[0]?.status).toBe("scheduled");
	});
});
