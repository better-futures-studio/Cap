import { Exit, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAskVideoReferences, trimTranscriptForAsk } from "@/lib/ask-video";

const mocks = vi.hoisted(() => ({
	runPromiseExit: vi.fn(),
	runPromise: vi.fn(),
	isAiConfigured: vi.fn(),
	isRateLimited: vi.fn(),
	getCurrentUser: vi.fn(),
	headers: vi.fn(),
	readLiveTranscript: vi.fn(),
	generateText: vi.fn(),
	runWithAiProviders: vi.fn(),
	dbSelect: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
	headers: mocks.headers,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: mocks.dbSelect,
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: (effect: unknown) => effect,
	VideosPolicy: {},
	Storage: {
		getAccessForVideo: vi.fn(),
	},
}));

vi.mock("@/lib/server", () => ({
	runPromiseExit: mocks.runPromiseExit,
	runPromise: mocks.runPromise,
}));

vi.mock("@/lib/ai/provider", () => ({
	isAiConfigured: mocks.isAiConfigured,
}));

vi.mock("@/lib/ai/run", () => ({
	runWithAiProviders: mocks.runWithAiProviders,
}));

vi.mock("ai", () => ({
	generateText: mocks.generateText,
}));

vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: mocks.isRateLimited,
	RATE_LIMIT_IDS: { ASK_VIDEO: "rl_ask_video" },
}));

vi.mock("@/lib/recall/live-transcript", () => ({
	readLiveTranscript: mocks.readLiveTranscript,
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: vi.fn((video: unknown) => video),
}));

const completeVideo = {
	id: "video-1",
	ownerId: "user-1",
	transcriptionStatus: "COMPLETE",
	metadata: {
		summary: "We decided to launch Friday.",
		chapters: [{ title: "Launch plan", start: 135 }],
		meetingActionItems: [
			{ text: "Prepare release notes", owner: "Lin", due: "Friday" },
		],
	},
};

const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello everyone

00:02:15.000 --> 00:02:18.000
We will launch Friday
`;

function succeedVideo(video: Record<string, unknown> | null) {
	mocks.runPromiseExit.mockResolvedValue(Exit.succeed(video ? [video] : []));
}

function failAccess() {
	mocks.runPromiseExit.mockResolvedValue(Exit.fail(new Error("denied")));
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isAiConfigured.mockReturnValue(true);
	mocks.isRateLimited.mockResolvedValue(false);
	mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
	mocks.headers.mockResolvedValue(
		new Headers({ "x-forwarded-for": "203.0.113.10" }),
	);
	mocks.dbSelect.mockReturnValue({
		from: () => ({
			where: () => ({
				limit: () => Promise.resolve([]),
			}),
		}),
	});
	mocks.runPromise.mockResolvedValue(Option.some(vtt));
	mocks.runWithAiProviders.mockImplementation(
		async (
			_role: string,
			run: (selection: {
				model: () => string;
				defaultMaxOutputTokens: number;
			}) => Promise<string>,
		) =>
			run({
				model: () => "mock-model",
				defaultMaxOutputTokens: 512,
			}),
	);
	mocks.generateText.mockResolvedValue({
		text: "They agreed to launch on Friday [02:15].",
	});
});

describe("parseAskVideoReferences", () => {
	it("parses [mm:ss] and [h:mm:ss], de-duplicates, and sorts", () => {
		expect(
			parseAskVideoReferences(
				"Launch is Friday [02:15] and the recap is at [1:02:03]. See also [02:15] and [00:05].",
			),
		).toEqual([
			{ seconds: 5, label: "00:05" },
			{ seconds: 135, label: "02:15" },
			{ seconds: 3723, label: "1:02:03" },
		]);
	});

	it("accepts unpadded minutes", () => {
		expect(parseAskVideoReferences("Said at [1:23].")).toEqual([
			{ seconds: 83, label: "1:23" },
		]);
	});
});

describe("trimTranscriptForAsk", () => {
	it("keeps the beginning and the end when over budget", () => {
		const { text, trimmed } = trimTranscriptForAsk(
			`${"START".repeat(20)}${"END".repeat(20)}`,
			80,
		);

		expect(trimmed).toBe(true);
		expect(text.startsWith("START")).toBe(true);
		expect(text.endsWith("END")).toBe(true);
		expect(text).toContain("Transcript trimmed");
		expect(text.length).toBeLessThanOrEqual(80);
	});

	it("leaves short transcripts alone", () => {
		expect(trimTranscriptForAsk("hello")).toEqual({
			text: "hello",
			trimmed: false,
		});
	});
});

describe("askVideo", () => {
	it("throws Forbidden when the viewer cannot access the video", async () => {
		failAccess();
		const { askVideo } = await import("@/actions/videos/ask");

		await expect(
			askVideo({ videoId: "video-1", question: "What was decided?" }),
		).rejects.toThrow("Forbidden");
		expect(mocks.generateText).not.toHaveBeenCalled();
	});

	it("answers from the transcript and leaves timestamp markers in the text", async () => {
		succeedVideo(completeVideo);
		const { askVideo } = await import("@/actions/videos/ask");

		const result = await askVideo({
			videoId: "video-1",
			question: "When is the launch?",
			history: [
				{ role: "user", content: "What is this about?" },
				{ role: "assistant", content: "A launch plan." },
			],
		});

		expect(result.answer).toContain("[02:15]");
		expect(result.references).toEqual([{ seconds: 135, label: "02:15" }]);
		expect(mocks.runWithAiProviders).toHaveBeenCalledWith(
			"chat",
			expect.any(Function),
		);
		const generateArgs = mocks.generateText.mock.calls[0]?.[0];
		expect(generateArgs.system).toContain(
			"Answer only from the provided material",
		);
		expect(generateArgs.system).toContain("[mm:ss]");
		expect(generateArgs.messages.at(-1)).toEqual({
			role: "user",
			content: "When is the launch?",
		});
		expect(JSON.stringify(generateArgs.messages)).toContain(
			"[02:15] We will launch Friday",
		);
		expect(JSON.stringify(generateArgs.messages)).toContain("A launch plan.");
	});
});

describe("getAskVideoAvailability", () => {
	it("returns forbidden when the viewer cannot access the video", async () => {
		failAccess();
		const { getAskVideoAvailability } = await import("@/actions/videos/ask");

		expect(await getAskVideoAvailability({ videoId: "video-1" })).toEqual({
			available: false,
			reason: "forbidden",
		});
	});

	it("returns no-transcript when transcription is not complete", async () => {
		succeedVideo({
			...completeVideo,
			transcriptionStatus: "PROCESSING",
		});
		const { getAskVideoAvailability } = await import("@/actions/videos/ask");

		expect(await getAskVideoAvailability({ videoId: "video-1" })).toEqual({
			available: false,
			reason: "no-transcript",
		});
		expect(mocks.runPromise).not.toHaveBeenCalled();
	});

	it("returns no-transcript when the VTT is missing", async () => {
		succeedVideo(completeVideo);
		mocks.runPromise.mockResolvedValue(Option.none());
		const { getAskVideoAvailability } = await import("@/actions/videos/ask");

		expect(await getAskVideoAvailability({ videoId: "video-1" })).toEqual({
			available: false,
			reason: "no-transcript",
		});
	});

	it("returns ai-disabled when no chat provider is configured", async () => {
		succeedVideo(completeVideo);
		mocks.isAiConfigured.mockReturnValue(false);
		const { getAskVideoAvailability } = await import("@/actions/videos/ask");

		expect(await getAskVideoAvailability({ videoId: "video-1" })).toEqual({
			available: false,
			reason: "ai-disabled",
		});
	});
});
