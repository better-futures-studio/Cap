import { describe, expect, it, vi } from "vitest";
import { createRecallClient, RecallApiError } from "@/lib/recall/client";
import type { RecallConfig } from "@/lib/recall/config";

const config: RecallConfig = {
	apiKey: "test-api-key",
	region: "us-west-2",
	baseUrl: "https://us-west-2.recall.ai",
	verificationSecret: null,
	botName: "Meeting Notetaker",
	publicBaseUrl: "https://cap.example.com",
	botImageUrl: "https://cap.example.com/api/meeting-bot/card",
	liveAgent: false,
	agentTrigger: "/nt",
	transcriptionProvider: "recallai",
	calendarGoogle: null,
	mediaRetentionHours: 168,
	deleteMediaAfterImport: true,
};

function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers,
	});
}

describe("createRecallClient", () => {
	it("sets the Authorization header without a scheme", async () => {
		const fetchMock = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				jsonResponse(200, { id: "bot_1" }),
		);
		const client = createRecallClient(config, { fetch: fetchMock });

		await client.getBot("bot_1");

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("test-api-key");
	});

	it("sends the createBot body shape", async () => {
		const fetchMock = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				jsonResponse(200, { id: "bot_1" }),
		);
		const client = createRecallClient(config, { fetch: fetchMock });

		await client.createBot({
			meetingUrl: "https://zoom.us/j/123",
			joinAt: "2026-01-01T00:00:00.000Z",
			botName: "Meeting Notetaker",
			metadata: { cap_meeting_bot_id: "mb_1" },
			joinChatMessage: "Meeting Notetaker is recording this meeting.",
		});

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://us-west-2.recall.ai/api/v1/bot/");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			meeting_url: "https://zoom.us/j/123",
			join_at: "2026-01-01T00:00:00.000Z",
			bot_name: "Meeting Notetaker",
			metadata: { cap_meeting_bot_id: "mb_1" },
			chat: {
				on_bot_join: {
					send_to: "everyone",
					message: "Meeting Notetaker is recording this meeting.",
					pin: true,
				},
			},
			recording_config: {
				retention: { type: "timed", hours: 168 },
			},
		});
	});

	it("POSTs deleteBotMedia to the Recall delete_media URL", async () => {
		const fetchMock = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				jsonResponse(204, undefined),
		);
		const client = createRecallClient(config, { fetch: fetchMock });

		await client.deleteBotMedia("bot_1");

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://us-west-2.recall.ai/api/v1/bot/bot_1/delete_media/",
		);
		expect(init.method).toBe("POST");
	});

	it("retries a 429 for the Retry-After duration then succeeds", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "2" }))
			.mockResolvedValueOnce(jsonResponse(200, { id: "bot_1" }));
		const sleep = vi.fn(async () => undefined);
		const client = createRecallClient(config, {
			fetch: fetchMock,
			sleep,
			random: () => 0,
		});

		const bot = await client.getBot("bot_1");

		expect(bot).toEqual({ id: "bot_1" });
		expect(sleep).toHaveBeenCalledWith(2000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("backs off 10s on 503 and 30s on 507", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(503, {}))
			.mockResolvedValueOnce(jsonResponse(507, {}))
			.mockResolvedValueOnce(jsonResponse(200, { id: "bot_1" }));
		const sleep = vi.fn(async () => undefined);
		const client = createRecallClient(config, {
			fetch: fetchMock,
			sleep,
			random: () => 0,
		});

		await client.getBot("bot_1");

		expect(sleep).toHaveBeenNthCalledWith(1, 10_000);
		expect(sleep).toHaveBeenNthCalledWith(2, 30_000);
	});

	it("gives up after 6 attempts and throws RecallApiError", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(503, { detail: "down" }));
		const sleep = vi.fn(async () => undefined);
		const client = createRecallClient(config, {
			fetch: fetchMock,
			sleep,
			random: () => 0,
		});

		await expect(client.getBot("bot_1")).rejects.toMatchObject({
			status: 503,
		});
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(sleep).toHaveBeenCalledTimes(5);
	});

	it("throws RecallApiError with the status for a non-retryable error", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse(400, { detail: "bad meeting url" }),
		);
		const client = createRecallClient(config, { fetch: fetchMock });

		await expect(client.getBot("bot_1")).rejects.toBeInstanceOf(RecallApiError);
		await expect(client.getBot("bot_1")).rejects.toMatchObject({
			status: 400,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("PATCHes a Slack team with the bot name", async () => {
		const fetchMock = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				jsonResponse(200, { id: "team_1" }),
		);
		const client = createRecallClient(config, { fetch: fetchMock });

		await client.activateSlackTeam("team_1", { botName: "Meeting Notetaker" });

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://us-west-2.recall.ai/api/v2/slack-teams/team_1/");
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(init.body as string)).toEqual({
			bot_name: "Meeting Notetaker",
		});
	});

	it("sends key_terms and spelling on createAsyncTranscript", async () => {
		const fetchMock = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				jsonResponse(200, { id: "tr_1" }),
		);
		const client = createRecallClient(config, { fetch: fetchMock });

		await client.createAsyncTranscript("rec_1", {
			keyTerms: ["Acme Corp", "Cap"],
			spelling: [{ find: ["acmecorp"], replace: "Acme Corp" }],
		});

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://us-west-2.recall.ai/api/v1/recording/rec_1/create_transcript/",
		);
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			provider: {
				recallai_async: {
					language_code: "auto",
					key_terms: ["Acme Corp", "Cap"],
					spelling: [{ find: ["acmecorp"], replace: "Acme Corp" }],
				},
			},
			diarization: { use_separate_streams_when_available: true },
		});
	});

	it("maps vocabulary to keyterms_prompt and custom_spelling for assemblyai", async () => {
		const fetchMock = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				jsonResponse(200, { id: "tr_1" }),
		);
		const client = createRecallClient(config, { fetch: fetchMock });

		await client.createAsyncTranscript("rec_1", {
			provider: "assemblyai",
			keyTerms: ["Acme Corp", "Cap"],
			spelling: [{ find: ["acmecorp"], replace: "Acme Corp" }],
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({
			provider: {
				assembly_ai_async: {
					speech_models: ["universal-2"],
					language_detection: true,
					language_detection_options: { code_switching: true },
					keyterms_prompt: ["Acme Corp", "Cap"],
					custom_spelling: [{ from: ["acmecorp"], to: "Acme Corp" }],
				},
			},
			diarization: { use_separate_streams_when_available: true },
		});
	});

	it("ignores 404 when deleting a Slack team", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(404, {}));
		const client = createRecallClient(config, { fetch: fetchMock });

		await expect(client.deleteSlackTeam("team_1")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("follows pagination when listing calendar events, capped by page count", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(200, {
					next: "https://us-west-2.recall.ai/api/v2/calendar-events/?cursor=abc",
					results: [{ id: "evt_1" }],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse(200, { next: null, results: [{ id: "evt_2" }] }),
			);
		const client = createRecallClient(config, { fetch: fetchMock });

		const events = await client.listCalendarEvents({ calendarId: "cal_1" });

		expect(events.map((event) => event.id)).toEqual(["evt_1", "evt_2"]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const secondUrl = (fetchMock.mock.calls[1] as [string, RequestInit])[0];
		expect(secondUrl).toBe(
			"https://us-west-2.recall.ai/api/v2/calendar-events/?cursor=abc",
		);
	});
});
