import type { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	queueVideoTranscription: vi.fn(),
	maybeDeleteImportedRecallMedia: vi.fn(),
	claimMeetingBotImport: vi.fn(),
	getRecording: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/schema", () => {
	const table = (name: string, fields: string[]) =>
		Object.fromEntries([
			["table", name],
			...fields.map((field) => [field, `${name}.${field}`]),
		]);
	return {
		meetingBots: table("meeting_bots", ["id", "status", "statusSubCode"]),
		videos: table("videos", ["id", "transcriptionStatus"]),
		videoUploads: table("video_uploads", ["videoId"]),
		comments: table("comments", ["id"]),
	};
});
vi.mock("drizzle-orm", () => ({
	eq: (column: string, value: unknown) => ({ column, value }),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({ Storage: {} }));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: mocks.queueVideoTranscription,
}));
vi.mock("@/lib/recall/media-retention", () => ({
	maybeDeleteImportedRecallMedia: mocks.maybeDeleteImportedRecallMedia,
}));
vi.mock("@/lib/recall/vocabulary", () => ({}));
vi.mock("@/lib/recall/default-client", () => ({
	getDefaultRecallClient: () => ({ getRecording: mocks.getRecording }),
}));
vi.mock("@/lib/recall/shared-recording", () => ({
	claimMeetingBotImport: mocks.claimMeetingBotImport,
	sharedMeetingSubCode: (id: string) => `shared:${id}`,
}));
vi.mock("@/lib/recall/chat-comments", () => ({}));
vi.mock("@/lib/recall/live-transcript", () => ({}));
vi.mock("@/lib/recall/speaker-stats", () => ({}));
vi.mock("@/lib/recall/visibility", () => ({}));
vi.mock("@/lib/generate-ai", () => ({}));
vi.mock("@/lib/video-processing", () => ({}));
vi.mock("@/lib/video-storage", () => ({}));
vi.mock("@/lib/workflow-runtime", () => ({}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));

type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;

function createClient() {
	return {
		update(table: { table: string }) {
			return {
				set: (values: Row) => ({
					where: async (condition: { column: string; value: unknown }) => {
						const key = condition.column.split(".")[1] ?? "";
						for (const row of rows[table.table] ?? []) {
							if (row[key] === condition.value) Object.assign(row, values);
						}
					},
				}),
			};
		},
	};
}

const { applyCapTranscriptionFallback } = await import(
	"@/lib/recall/create-transcript"
);
const { importRecallRecordingWorkflow } = await import(
	"@/workflows/recall-meeting"
);

beforeEach(() => {
	rows = {
		meeting_bots: [
			{ id: "mb_1", status: "in_call_recording", statusSubCode: null },
		],
		videos: [{ id: "vid_1", transcriptionStatus: "PROCESSING" }],
	};
	mocks.db.mockReturnValue(createClient());
	mocks.queueVideoTranscription.mockReset();
	mocks.maybeDeleteImportedRecallMedia.mockReset();
	mocks.claimMeetingBotImport.mockReset();
	mocks.getRecording.mockReset();
});

describe("applyCapTranscriptionFallback", () => {
	it("leaves a row that is still in the call alone", async () => {
		await applyCapTranscriptionFallback("mb_1", null);

		expect(rows.meeting_bots?.[0]?.status).toBe("in_call_recording");
		expect(mocks.queueVideoTranscription).not.toHaveBeenCalled();
	});

	it("falls back to Cap transcription once the video exists", async () => {
		await applyCapTranscriptionFallback("mb_1", "vid_1" as Video.VideoId);

		expect(rows.meeting_bots?.[0]).toMatchObject({
			status: "transcribing",
			statusSubCode: "cap_fallback",
		});
		expect(rows.videos?.[0]?.transcriptionStatus).toBeNull();
		expect(mocks.queueVideoTranscription).toHaveBeenCalledWith("vid_1");
	});
});

describe("importRecallRecordingWorkflow", () => {
	it("does not claim the row before Recall has a download URL", async () => {
		mocks.getRecording.mockResolvedValue({
			id: "rec_1",
			status: { code: "processing" },
			media_shortcuts: {},
		});

		await importRecallRecordingWorkflow({
			meetingBotId: "mb_1",
			recordingId: "rec_1",
		});

		expect(mocks.getRecording).toHaveBeenCalledWith("rec_1");
		expect(mocks.claimMeetingBotImport).not.toHaveBeenCalled();
		expect(rows.meeting_bots?.[0]?.status).toBe("in_call_recording");
	});
});
