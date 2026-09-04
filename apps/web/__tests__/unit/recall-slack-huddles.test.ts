import type { Organisation, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	activateSlackTeam: vi.fn(),
	getBot: vi.fn(),
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
			"source",
			"meetingUrl",
			"title",
			"joinAt",
			"recallBotId",
			"status",
			"statusSubCode",
			"statusUpdatedAt",
			"errorMessage",
			"slackTeamId",
			"slackChannelId",
			"createdAt",
			"updatedAt",
		]),
		slackHuddleTeams: table("slack_huddle_teams", [
			"id",
			"orgId",
			"recallSlackTeamId",
			"botName",
			"status",
			"workspaceName",
			"createdAt",
			"updatedAt",
		]),
		organizations: table("organizations", ["id", "ownerId"]),
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
	lt: (column: string, value: unknown) => ({ op: "lt", column, value }),
	or: (...args: unknown[]) => ({ op: "or", args }),
	isNull: (column: string) => ({ op: "isNull", column }),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ CAP_DEFAULT_ORG_ID: "org_1" }),
}));
vi.mock("@/lib/recall/config", () => ({
	DEFAULT_BOT_NAME: "Meeting Notetaker",
	getRecallConfig: () => ({
		apiKey: "test-api-key",
		region: "us-west-2",
		baseUrl: "https://us-west-2.recall.ai",
		verificationSecret: null,
		botName: "Meeting Notetaker",
		publicBaseUrl: "https://cap.example.com",
		botImageUrl: "https://cap.example.com/api/meeting-bot/card",
		calendarGoogle: null,
	}),
	isRecallConfigured: () => true,
}));
vi.mock("@/lib/recall/default-client", () => ({
	getDefaultRecallClient: () => ({
		activateSlackTeam: mocks.activateSlackTeam,
		getBot: mocks.getBot,
	}),
}));
vi.mock("@/lib/recall/bot-image", () => ({
	loadBotVideoOutput: vi.fn(async () => null),
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
	importRecallRecordingWorkflow: {},
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));

import { applyBotStatusEvent } from "@/lib/recall/bots";
import { dispatchRecallWebhook } from "@/lib/recall/webhooks";

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

function tableRows(name: string): Row[] {
	const list = rows[name];
	if (!list) throw new Error(`expected ${name} rows`);
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
	if (condition.op === "notIn") {
		return Array.isArray(condition.value) && !condition.value.includes(value);
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
					const tableRowsList = rows[table.table];
					const next = {
						title: null,
						recallBotId: null,
						statusSubCode: null,
						errorMessage: null,
						statusUpdatedAt: null,
						createdAt: now,
						updatedAt: now,
						...values,
					};
					if (tableRowsList) tableRowsList.push(next);
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

beforeEach(() => {
	rows = {
		meeting_bots: [],
		slack_huddle_teams: [],
		organizations: [{ id: orgId, ownerId: userId }],
	};
	mocks.db.mockReturnValue(createClient());
	mocks.activateSlackTeam.mockReset().mockResolvedValue(undefined);
	mocks.getBot.mockReset();
});

describe("slack_team webhooks", () => {
	it("creates a team row and activates it on slack_team.invited", async () => {
		await dispatchRecallWebhook({
			event: "slack_team.invited",
			data: {
				data: {
					code: "invited",
					sub_code: null,
					updated_at: "2026-09-03T16:00:00.000Z",
				},
				slack_team: { id: "team_1", metadata: {} },
			},
		});

		expect(mocks.activateSlackTeam).toHaveBeenCalledOnce();
		expect(mocks.activateSlackTeam).toHaveBeenCalledWith("team_1", {
			botName: "Meeting Notetaker",
		});
		expect(tableRows("slack_huddle_teams")).toHaveLength(1);
		expect(tableRows("slack_huddle_teams")[0]).toMatchObject({
			orgId,
			recallSlackTeamId: "team_1",
			botName: "Meeting Notetaker",
			status: "active",
		});
	});

	it("marks the team revoked and cancels its non-terminal bots", async () => {
		rows.slack_huddle_teams = [
			{
				id: "sht_1",
				orgId,
				recallSlackTeamId: "team_1",
				botName: "Meeting Notetaker",
				status: "active",
			},
		];
		rows.meeting_bots = [
			{
				id: "mb_live",
				slackTeamId: "team_1",
				status: "in_call_recording",
			},
			{
				id: "mb_done",
				slackTeamId: "team_1",
				status: "complete",
			},
			{
				id: "mb_other",
				slackTeamId: "team_other",
				status: "scheduled",
			},
		];

		await dispatchRecallWebhook({
			event: "slack_team.access_revoked",
			data: {
				data: { code: "access_revoked", sub_code: null },
				slack_team: { id: "team_1", metadata: {} },
			},
		});

		expect(tableRows("slack_huddle_teams")[0]?.status).toBe("revoked");
		expect(tableRows("meeting_bots").map((row) => row.status)).toEqual([
			"cancelled",
			"complete",
			"scheduled",
		]);
	});
});

describe("slack huddle bot status events", () => {
	it("creates a slack row for an unknown bot with a slack team", async () => {
		rows.slack_huddle_teams = [
			{
				id: "sht_1",
				orgId,
				recallSlackTeamId: "team_1",
				botName: "Meeting Notetaker",
				status: "active",
			},
		];
		mocks.getBot.mockResolvedValue({
			id: "bot_slack",
			status_changes: [],
			recordings: [],
			slack_team: { id: "team_1" },
			meeting_metadata: {
				title: "Design huddle",
				slack_channel_id: "C123",
			},
		});

		await applyBotStatusEvent({
			recallBotId: "bot_slack",
			code: "in_call_recording",
		});

		expect(mocks.getBot).toHaveBeenCalledWith("bot_slack");
		expect(tableRows("meeting_bots")).toHaveLength(1);
		expect(tableRows("meeting_bots")[0]).toMatchObject({
			source: "slack",
			meetingUrl: "",
			title: "Design huddle",
			orgId,
			ownerId: userId,
			recallBotId: "bot_slack",
			slackTeamId: "team_1",
			slackChannelId: "C123",
			status: "in_call_recording",
		});
	});

	it("ignores an unknown bot without a slack team", async () => {
		mocks.getBot.mockResolvedValue({
			id: "bot_zoom",
			status_changes: [],
			recordings: [],
			slack_team: null,
		});

		await applyBotStatusEvent({
			recallBotId: "bot_zoom",
			code: "in_call_recording",
		});

		expect(mocks.getBot).toHaveBeenCalledWith("bot_zoom");
		expect(tableRows("meeting_bots")).toHaveLength(0);
	});
});
