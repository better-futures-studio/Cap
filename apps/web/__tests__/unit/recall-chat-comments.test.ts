import type { User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildJoinChatMessage } from "@/lib/recall/bot-chat";
import { importMeetingChatComments } from "@/lib/recall/chat-comments";
import {
	RecallApiError,
	type RecallClient,
	type RecallParticipantEvent,
} from "@/lib/recall/client";
import type {
	LiveChatEntry,
	LiveTranscript,
} from "@/lib/recall/live-transcript";

const botName = "Meeting Notetaker";
const agentTrigger = "/nt";
const joinMessage = buildJoinChatMessage({
	botName,
	liveAgent: true,
	agentTrigger,
});

function botParticipant() {
	return {
		id: 99,
		name: botName,
		is_host: false,
		email: null,
	};
}

const mocks = vi.hoisted(() => ({ db: vi.fn() }));
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
		]),
		comments: table("comments", [
			"id",
			"type",
			"content",
			"timestamp",
			"authorId",
			"videoId",
			"createdAt",
			"updatedAt",
		]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
	inArray: (column: string, value: unknown[]) => ({ op: "in", column, value }),
	isNull: (column: string) => ({ op: "isNull", column }),
	isNotNull: (column: string) => ({ op: "isNotNull", column }),
}));
vi.mock("@/lib/recall/config", () => ({
	DEFAULT_BOT_NAME: "Meeting Notetaker",
	getRecallConfig: () => null,
	isRecallConfigured: () => false,
}));
vi.mock("@/lib/recall/default-client", () => ({
	getDefaultRecallClient: () => {
		throw new Error("default Recall client should not be used in tests");
	},
}));
vi.mock("@/lib/recall/live-transcript", () => ({
	readLiveTranscript: vi.fn(async () => null),
}));

type Row = Record<string, unknown>;
type Table = { table: string };
type Condition = {
	op: string;
	args?: (Condition | undefined)[];
	column?: string;
	value?: unknown;
};

const ownerId = "user_1" as User.UserId;
const videoId = "vid_1" as Video.VideoId;
const now = new Date("2026-09-03T16:00:00.000Z");

let rows: Record<string, Row[]>;

function bots(): Row[] {
	const list = rows.meeting_bots;
	if (!list) throw new Error("expected meeting_bots rows");
	return list;
}

function commentRows(): Row[] {
	return rows.comments ?? [];
}

function matches(row: Row, condition?: Condition): boolean {
	if (!condition) return true;
	if (condition.op === "and") {
		return (condition.args ?? []).every((part) => matches(row, part));
	}
	const key = condition.column?.split(".")[1] ?? "";
	const value = row[key];
	if (condition.op === "isNull") return value === null || value === undefined;
	if (condition.op === "isNotNull")
		return value !== null && value !== undefined;
	if (condition.op === "eq") return value === condition.value;
	if (condition.op === "in") {
		return Array.isArray(condition.value) && condition.value.includes(value);
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
				values: async (values: Row | Row[]) => {
					const items = Array.isArray(values) ? values : [values];
					const tableRows = rows[table.table] ?? [];
					rows[table.table] = tableRows;
					for (const value of items) {
						tableRows.push({
							createdAt: now,
							updatedAt: now,
							...value,
						});
					}
					return [{ affectedRows: items.length }];
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

function participantEvent(
	overrides: Partial<RecallParticipantEvent> &
		Pick<RecallParticipantEvent, "action">,
): RecallParticipantEvent {
	return {
		id: overrides.id ?? "evt",
		action: overrides.action,
		timestamp: overrides.timestamp ?? {
			absolute: "2026-09-03T16:00:10.000Z",
			relative: 10,
		},
		participant: overrides.participant ?? {
			id: 1,
			name: "Alice",
			is_host: true,
			email: "alice@example.com",
		},
		data: overrides.data === undefined ? null : overrides.data,
	};
}

function liveTranscript(chat: LiveChatEntry[]): LiveTranscript {
	return {
		version: 1,
		updatedAt: "2026-09-03T16:00:00.000Z",
		utterances: [],
		captures: [],
		chat,
	};
}

function seedBot(overrides: Row = {}) {
	rows.meeting_bots = [
		{
			id: "mb_1",
			ownerId,
			videoId,
			recallRecordingId: "rec_1",
			chatSyncedAt: null,
			status: "transcribing",
			...overrides,
		},
	];
}

function mockClient(
	overrides: {
		getRecording?: RecallClient["getRecording"];
		downloadJson?: RecallClient["downloadJson"];
	} = {},
): RecallClient {
	return {
		getRecording: vi.fn(async () => ({
			id: "rec_1",
			status: { code: "done" },
			media_shortcuts: {
				participant_events: {
					data: {
						participant_events_download_url: "https://example.com/events.json",
					},
				},
			},
		})),
		downloadJson: vi.fn(async () => []),
		...overrides,
	} as RecallClient;
}

beforeEach(() => {
	rows = { meeting_bots: [], comments: [] };
	mocks.db.mockReturnValue(createClient());
});

describe("importMeetingChatComments", () => {
	it("imports chat events as comments with name prefix and relative timestamps", async () => {
		seedBot();
		const events: RecallParticipantEvent[] = [
			participantEvent({
				id: "join",
				action: "join",
				timestamp: { absolute: "2026-09-03T16:00:00.000Z", relative: 0 },
			}),
			participantEvent({
				id: "chat_alice",
				action: "chat_message",
				timestamp: { absolute: "2026-09-03T16:00:12.345Z", relative: 12.3456 },
				data: { text: "  hello team  ", to: "everyone" },
			}),
			participantEvent({
				id: "leave",
				action: "leave",
				timestamp: { absolute: "2026-09-03T16:01:00.000Z", relative: 60 },
			}),
			participantEvent({
				id: "bot_pin",
				action: "chat_message",
				timestamp: { absolute: "2026-09-03T16:00:01.000Z", relative: 1 },
				participant: botParticipant(),
				data: {
					text: joinMessage,
					to: "everyone",
				},
			}),
			participantEvent({
				id: "bot_reply",
				action: "chat_message",
				timestamp: { absolute: "2026-09-03T16:00:30.000Z", relative: 30 },
				participant: botParticipant(),
				data: {
					text: "The launch is Friday.",
					to: "everyone",
				},
			}),
			participantEvent({
				id: "chat_anon",
				action: "chat_message",
				timestamp: { absolute: "2026-09-03T16:00:45.000Z", relative: 45 },
				participant: {
					id: 2,
					name: null,
					is_host: false,
					email: null,
				},
				data: { text: "on my way", to: "everyone" },
			}),
			participantEvent({
				id: "empty",
				action: "chat_message",
				timestamp: { absolute: "2026-09-03T16:00:50.000Z", relative: 50 },
				data: { text: "   ", to: "everyone" },
			}),
			participantEvent({
				id: "negative",
				action: "chat_message",
				timestamp: { absolute: "2026-09-03T15:59:00.000Z", relative: -1 },
				data: { text: "too early", to: "everyone" },
			}),
		];
		const client = mockClient({
			downloadJson: vi.fn(async () => events) as RecallClient["downloadJson"],
		});

		const result = await importMeetingChatComments(
			{ meetingBotId: "mb_1" },
			{ client },
		);

		expect(result).toEqual({ imported: 3, skipped: false });
		expect(bots()[0]?.chatSyncedAt).toBeInstanceOf(Date);
		expect(commentRows()).toEqual([
			expect.objectContaining({
				type: "text",
				content: "Alice: hello team",
				timestamp: 12.346,
				authorId: ownerId,
				videoId,
			}),
			expect.objectContaining({
				type: "text",
				content: `${botName}: The launch is Friday.`,
				timestamp: 30,
				authorId: ownerId,
				videoId,
			}),
			expect.objectContaining({
				type: "text",
				content: "Participant: on my way",
				timestamp: 45,
				authorId: ownerId,
				videoId,
			}),
		]);
		expect(client.getRecording).toHaveBeenCalledWith("rec_1");
		expect(client.downloadJson).toHaveBeenCalledWith(
			"https://example.com/events.json",
		);
	});

	it("imports agent questions, skips captures, and keeps a plain chat message", async () => {
		seedBot();
		const events: RecallParticipantEvent[] = [
			participantEvent({
				id: "command",
				action: "chat_message",
				data: { text: "  /NT what did we decide?  ", to: "everyone" },
			}),
			participantEvent({
				id: "note",
				action: "chat_message",
				timestamp: { absolute: "2026-09-03T16:00:15.000Z", relative: 15 },
				data: { text: "/nt note: Follow up with Ada", to: "everyone" },
			}),
			participantEvent({
				id: "action",
				action: "chat_message",
				timestamp: { absolute: "2026-09-03T16:00:16.000Z", relative: 16 },
				data: { text: "/nt action item: Ship the recap", to: "everyone" },
			}),
			participantEvent({
				id: "plain",
				action: "chat_message",
				timestamp: { absolute: "2026-09-03T16:00:20.000Z", relative: 20 },
				data: { text: "shipping tomorrow", to: "everyone" },
			}),
		];
		const client = mockClient({
			downloadJson: vi.fn(async () => events) as RecallClient["downloadJson"],
		});

		const result = await importMeetingChatComments(
			{ meetingBotId: "mb_1" },
			{ client },
		);

		expect(result).toEqual({ imported: 2, skipped: false });
		expect(commentRows()).toEqual([
			expect.objectContaining({
				type: "text",
				content: `Alice (to ${botName}): what did we decide?`,
				timestamp: 10,
				authorId: ownerId,
				videoId,
			}),
			expect.objectContaining({
				type: "text",
				content: "Alice: shipping tomorrow",
				timestamp: 20,
				authorId: ownerId,
				videoId,
			}),
		]);
	});

	it("skips a second call once chatSyncedAt is set", async () => {
		seedBot();
		const client = mockClient({
			downloadJson: vi.fn(async () => [
				participantEvent({
					id: "chat",
					action: "chat_message",
					data: { text: "hello", to: "everyone" },
				}),
			]) as RecallClient["downloadJson"],
		});

		const first = await importMeetingChatComments(
			{ meetingBotId: "mb_1" },
			{ client },
		);
		const second = await importMeetingChatComments(
			{ meetingBotId: "mb_1" },
			{ client },
		);

		expect(first).toEqual({ imported: 1, skipped: false });
		expect(second).toEqual({ imported: 0, skipped: true });
		expect(client.getRecording).toHaveBeenCalledOnce();
		expect(commentRows()).toHaveLength(1);
	});

	it("imports a bot reply from the stored live chat with a converted timestamp", async () => {
		seedBot();
		const client = mockClient();

		const result = await importMeetingChatComments(
			{ meetingBotId: "mb_1" },
			{
				client,
				readTranscript: async () =>
					liveTranscript([
						{
							t: 42.3456,
							speaker: botName,
							text: "  The launch is Friday.  ",
							fromBot: true,
						},
						{
							t: 10,
							speaker: "Alice",
							text: "hello team",
							fromBot: false,
						},
					]),
			},
		);

		expect(result).toEqual({ imported: 1, skipped: false });
		expect(commentRows()).toEqual([
			expect.objectContaining({
				type: "text",
				content: `${botName}: The launch is Friday.`,
				timestamp: 42.346,
				authorId: ownerId,
				videoId,
			}),
		]);
	});

	it("skips the join message stored in the live chat", async () => {
		seedBot();
		const client = mockClient();

		const result = await importMeetingChatComments(
			{ meetingBotId: "mb_1" },
			{
				client,
				readTranscript: async () =>
					liveTranscript([
						{
							t: 1,
							speaker: botName,
							text: joinMessage,
							fromBot: true,
						},
					]),
			},
		);

		expect(result).toEqual({ imported: 0, skipped: false });
		expect(commentRows()).toEqual([]);
	});

	it("does not insert a live bot reply that duplicates a Recall event", async () => {
		seedBot();
		const events: RecallParticipantEvent[] = [
			participantEvent({
				id: "bot_reply",
				action: "chat_message",
				timestamp: { absolute: "2026-09-03T16:00:30.000Z", relative: 30 },
				participant: botParticipant(),
				data: {
					text: "The launch is Friday.",
					to: "everyone",
				},
			}),
		];
		const client = mockClient({
			downloadJson: vi.fn(async () => events) as RecallClient["downloadJson"],
		});

		const result = await importMeetingChatComments(
			{ meetingBotId: "mb_1" },
			{
				client,
				readTranscript: async () =>
					liveTranscript([
						{
							t: 30.0004,
							speaker: botName,
							text: "  THE LAUNCH IS FRIDAY.  ",
							fromBot: true,
						},
					]),
			},
		);

		expect(result).toEqual({ imported: 1, skipped: false });
		expect(commentRows()).toEqual([
			expect.objectContaining({
				type: "text",
				content: `${botName}: The launch is Friday.`,
				timestamp: 30,
				authorId: ownerId,
				videoId,
			}),
		]);
	});

	it("skips a live chat capture acknowledgement", async () => {
		seedBot();
		const client = mockClient();

		const result = await importMeetingChatComments(
			{ meetingBotId: "mb_1" },
			{
				client,
				readTranscript: async () =>
					liveTranscript([
						{
							t: 18,
							speaker: botName,
							text: "Noted.",
							fromBot: true,
						},
					]),
			},
		);

		expect(result).toEqual({ imported: 0, skipped: false });
		expect(commentRows()).toEqual([]);
	});

	it("resets chatSyncedAt and rethrows when download fails", async () => {
		seedBot();
		const error = new RecallApiError(502, "Recall download failed (502)", null);
		const client = mockClient({
			downloadJson: vi.fn(async () => {
				throw error;
			}),
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await expect(
			importMeetingChatComments({ meetingBotId: "mb_1" }, { client }),
		).rejects.toBe(error);

		expect(bots()[0]?.chatSyncedAt).toBeNull();
		expect(commentRows()).toEqual([]);
		expect(consoleError).toHaveBeenCalledWith("[recall] chat import failed", {
			meetingBotId: "mb_1",
			status: 502,
		});
		consoleError.mockRestore();
	});
});
