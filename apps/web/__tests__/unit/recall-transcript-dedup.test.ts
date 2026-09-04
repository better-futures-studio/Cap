import type { Organisation, User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecallClient, RecallRecording } from "@/lib/recall/client";
import { createMeetingTranscript } from "@/lib/recall/create-transcript";
import { dispatchRecallWebhook } from "@/lib/recall/webhooks";
import { completeRecallTranscriptWorkflow } from "@/workflows/recall-meeting";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	start: vi.fn(),
	queueVideoTranscription: vi.fn(),
	listMeetingVocabularyTerms: vi.fn(),
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
			"calendarEventId",
			"recallBotId",
			"recallRecordingId",
			"recallTranscriptId",
			"status",
			"statusSubCode",
			"statusUpdatedAt",
			"errorMessage",
			"videoId",
			"createdAt",
			"updatedAt",
		]),
		videos: table("videos", ["id", "transcriptionStatus"]),
		organizations: table("organizations", ["id", "ownerId"]),
		slackHuddleTeams: table("slack_huddle_teams", [
			"id",
			"orgId",
			"recallSlackTeamId",
			"botName",
			"status",
		]),
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
	or: (...args: unknown[]) => ({ op: "or", args }),
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
		liveAgent: true,
		agentTrigger: "/nt",
		transcriptionProvider: "recallai",
		calendarGoogle: null,
	}),
	isRecallConfigured: () => true,
}));
vi.mock("@/lib/recall/default-client", () => ({
	getDefaultRecallClient: () => {
		throw new Error("default Recall client should not be used in tests");
	},
}));
vi.mock("@/lib/recall/calendars", () => ({
	syncCalendarStatus: vi.fn(),
}));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: mocks.queueVideoTranscription,
}));
vi.mock("@/lib/recall/vocabulary", () => ({
	listMeetingVocabularyTerms: mocks.listMeetingVocabularyTerms,
	toRecallTranscriptVocabulary: (terms: unknown) => terms,
}));
vi.mock("@/workflows/recall-calendar-sync", () => ({
	syncCalendarEventsWorkflow: {},
}));
vi.mock("@/workflows/recall-meeting", () => ({
	completeRecallTranscriptWorkflow: {
		name: "completeRecallTranscriptWorkflow",
	},
	failRecallTranscriptWorkflow: { name: "failRecallTranscriptWorkflow" },
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

const orgId = "org_1" as Organisation.OrganisationId;
const ownerId = "user_1" as User.UserId;
const videoId = "vid_1" as Video.VideoId;
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
	if (condition.op === "notIn") {
		return Array.isArray(condition.value) && !condition.value.includes(value);
	}
	throw new Error(`Unexpected condition ${condition.op}`);
}

function createDb() {
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

function seedBot(overrides: Row = {}) {
	rows.meeting_bots = [
		{
			id: "mb_1",
			orgId,
			ownerId,
			videoId,
			recallBotId: "bot_1",
			recallRecordingId: "rec_1",
			recallTranscriptId: null,
			status: "importing",
			statusSubCode: null,
			createdAt: now,
			...overrides,
		},
	];
}

function recordingWithTranscript(
	overrides: Partial<RecallRecording["media_shortcuts"]["transcript"]> = {},
): RecallRecording {
	return {
		id: "rec_1",
		status: { code: "done" },
		media_shortcuts: {
			transcript: {
				id: "tr_live",
				status: { code: "done" },
				...overrides,
			},
		},
	};
}

function mockClient(
	overrides: {
		getRecording?: RecallClient["getRecording"];
		createAsyncTranscript?: RecallClient["createAsyncTranscript"];
	} = {},
): RecallClient {
	return {
		getRecording: vi.fn(async () => ({
			id: "rec_1",
			status: { code: "done" },
			media_shortcuts: {},
		})),
		createAsyncTranscript: vi.fn(async () => ({ id: "tr_async" })),
		...overrides,
	} as RecallClient;
}

beforeEach(() => {
	rows = {
		meeting_bots: [],
		videos: [{ id: videoId, transcriptionStatus: "PROCESSING" }],
	};
	mocks.db.mockReturnValue(createDb());
	mocks.start.mockReset().mockResolvedValue(undefined);
	mocks.queueVideoTranscription.mockReset();
	mocks.listMeetingVocabularyTerms.mockReset().mockResolvedValue({
		keyTerms: [],
		spelling: [],
	});
});

describe("handleTranscriptDone fallback", () => {
	it("matches by recording id and starts completion for an unknown transcript id", async () => {
		seedBot();

		await dispatchRecallWebhook({
			event: "transcript.done",
			data: {
				data: { code: "done" },
				transcript: { id: "tr_live" },
				recording: { id: "rec_1" },
				bot: { id: "bot_1" },
			},
		});

		expect(bots()[0]).toMatchObject({
			recallTranscriptId: "tr_live",
			status: "transcribing",
		});
		expect(mocks.start).toHaveBeenCalledOnce();
		expect(mocks.start).toHaveBeenCalledWith(completeRecallTranscriptWorkflow, [
			{ meetingBotId: "mb_1", transcriptId: "tr_live" },
		]);
	});

	it("does not start completion twice for the same transcript id", async () => {
		seedBot();
		const payload = {
			event: "transcript.done",
			data: {
				data: { code: "done" },
				transcript: { id: "tr_live" },
				recording: { id: "rec_1" },
			},
		};

		await dispatchRecallWebhook(payload);
		await dispatchRecallWebhook(payload);

		expect(mocks.start).toHaveBeenCalledOnce();
		expect(bots()[0]?.recallTranscriptId).toBe("tr_live");
	});

	it("matches by bot id when the recording id is absent", async () => {
		seedBot({ recallRecordingId: null });

		await dispatchRecallWebhook({
			event: "transcript.done",
			data: {
				data: { code: "done" },
				transcript: { id: "tr_live" },
				bot: { id: "bot_1" },
			},
		});

		expect(bots()[0]?.recallTranscriptId).toBe("tr_live");
		expect(mocks.start).toHaveBeenCalledOnce();
	});
});

describe("createTranscript reuse", () => {
	it("reuses an existing recording transcript instead of creating another", async () => {
		seedBot();
		const client = mockClient({
			getRecording: vi.fn(async () =>
				recordingWithTranscript({ status: { code: "processing" } }),
			) as RecallClient["getRecording"],
		});

		const result = await createMeetingTranscript(
			{ meetingBotId: "mb_1", recordingId: "rec_1", videoId },
			{ client },
		);

		expect(result).toEqual({
			transcriptId: "tr_live",
			startCompletion: false,
		});
		expect(bots()[0]?.recallTranscriptId).toBe("tr_live");
		expect(bots()[0]?.status).toBe("importing");
		expect(client.createAsyncTranscript).not.toHaveBeenCalled();
		expect(client.getRecording).toHaveBeenCalledWith("rec_1");
	});

	it("starts completion when the existing transcript is already done", async () => {
		seedBot();
		const client = mockClient({
			getRecording: vi.fn(async () =>
				recordingWithTranscript(),
			) as RecallClient["getRecording"],
		});

		const result = await createMeetingTranscript(
			{ meetingBotId: "mb_1", recordingId: "rec_1", videoId },
			{ client },
		);

		expect(result).toEqual({
			transcriptId: "tr_live",
			startCompletion: true,
		});
		expect(bots()[0]).toMatchObject({
			recallTranscriptId: "tr_live",
			status: "transcribing",
		});
		expect(client.createAsyncTranscript).not.toHaveBeenCalled();
	});

	it("does not start completion twice when the stored id already matches", async () => {
		seedBot({
			recallTranscriptId: "tr_live",
			status: "transcribing",
		});
		const client = mockClient({
			getRecording: vi.fn(async () =>
				recordingWithTranscript(),
			) as RecallClient["getRecording"],
		});

		const result = await createMeetingTranscript(
			{ meetingBotId: "mb_1", recordingId: "rec_1", videoId },
			{ client },
		);

		expect(result).toEqual({
			transcriptId: "tr_live",
			startCompletion: false,
		});
		expect(client.getRecording).not.toHaveBeenCalled();
		expect(client.createAsyncTranscript).not.toHaveBeenCalled();
	});
});
