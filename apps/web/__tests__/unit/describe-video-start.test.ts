import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.fn();
const mockStart = vi.fn();

vi.mock("@cap/database", () => ({
	db: mockDb,
}));

vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		updatedAt: "videos.updatedAt",
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	})),
}));

vi.mock("workflow/api", () => ({
	start: mockStart,
}));

vi.mock("@/lib/ai/gemini-video", () => ({
	isVideoUnderstandingEnabled: () => true,
}));

vi.mock("@/workflows/describe-video", () => ({
	describeSilentVideoWorkflow: vi.fn(),
}));

function makeSelectChain(video: unknown) {
	const chain = { select: vi.fn(), from: vi.fn(), where: vi.fn() };
	chain.select.mockReturnValue(chain);
	chain.from.mockReturnValue(chain);
	chain.where.mockResolvedValue([{ video }]);
	return chain;
}

function makeUpdateChain(affectedRows: number) {
	const chain = { update: vi.fn(), set: vi.fn(), where: vi.fn() };
	chain.update.mockReturnValue(chain);
	chain.set.mockReturnValue(chain);
	chain.where.mockResolvedValue([{ affectedRows }]);
	return chain;
}

// A silent screen recording the AI generation workflow has just marked PROCESSING.
const processingVideo = {
	id: "video-1",
	isScreenshot: false,
	duration: 30,
	metadata: { aiGenerationStatus: "PROCESSING" },
	updatedAt: new Date("2026-11-04T17:00:00.000Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	mockStart.mockResolvedValue({ runId: "run-1" });
});

describe("startDescribeSilentVideo", () => {
	it("starts the description when the AI generation workflow hands a PROCESSING video over", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain(processingVideo))
			.mockReturnValueOnce(makeUpdateChain(1));
		const { startDescribeSilentVideo } = await import("@/lib/describe-video");

		const result = await startDescribeSilentVideo(
			"video-1" as never,
			"user-1",
			{ handoff: true },
		);

		expect(result).toEqual({
			success: true,
			message: "Video description workflow started",
		});
		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	it("still treats a PROCESSING video as in progress for any other caller", async () => {
		mockDb.mockReturnValueOnce(makeSelectChain(processingVideo));
		const { startDescribeSilentVideo } = await import("@/lib/describe-video");

		const result = await startDescribeSilentVideo("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "Video description already in progress",
		});
		expect(mockStart).not.toHaveBeenCalled();
	});
});
