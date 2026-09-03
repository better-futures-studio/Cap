import type { Organisation, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getCurrentUser: vi.fn(),
	requireOrganizationAccess: vi.fn(),
	parseMeetingUrl: vi.fn(),
	scheduleManualMeetingBot: vi.fn(),
	cancelMeetingBot: vi.fn(),
	getUserCalendar: vi.fn(),
	listUpcomingCalendarEvents: vi.fn(),
	setCalendarAutoRecord: vi.fn(),
	toggleCalendarEventRecording: vi.fn(),
	disconnectCalendar: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
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
			"title",
			"meetingUrl",
			"joinAt",
			"source",
			"status",
			"errorMessage",
			"videoId",
			"chatSyncedAt",
			"createdAt",
		]),
		videoUploads: table("video_uploads", ["videoId"]),
	};
});
vi.mock("drizzle-orm", () => ({
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
	desc: (column: string) => column,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationAccess: mocks.requireOrganizationAccess,
}));
vi.mock("@/lib/recall/config", () => ({
	isRecallConfigured: () => true,
	isRecallCalendarConfigured: () => true,
}));
vi.mock("@/lib/recall/bots", () => ({
	parseMeetingUrl: mocks.parseMeetingUrl,
	scheduleManualMeetingBot: mocks.scheduleManualMeetingBot,
	cancelMeetingBot: mocks.cancelMeetingBot,
}));
vi.mock("@/lib/recall/calendars", () => ({
	getUserCalendar: mocks.getUserCalendar,
	listUpcomingCalendarEvents: mocks.listUpcomingCalendarEvents,
	setCalendarAutoRecord: mocks.setCalendarAutoRecord,
	toggleCalendarEventRecording: mocks.toggleCalendarEventRecording,
	disconnectCalendar: mocks.disconnectCalendar,
}));

const { listMeetingBots, scheduleMeetingBot } = await import(
	"@/actions/meetings"
);

const orgId = "org" as Organisation.OrganisationId;
const userId = "user" as User.UserId;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getCurrentUser.mockResolvedValue({ id: userId });
	mocks.requireOrganizationAccess.mockResolvedValue({ id: orgId });
});

describe("scheduleMeetingBot", () => {
	it("rejects an unsupported URL before touching Recall", async () => {
		mocks.parseMeetingUrl.mockReturnValue(null);

		await expect(
			scheduleMeetingBot({ orgId, meetingUrl: "https://example.com/foo" }),
		).rejects.toThrow("Unsupported meeting URL");

		expect(mocks.scheduleManualMeetingBot).not.toHaveBeenCalled();
	});

	it("schedules a supported URL", async () => {
		mocks.parseMeetingUrl.mockReturnValue({
			url: "https://zoom.us/j/123",
			platform: "zoom",
		});
		mocks.scheduleManualMeetingBot.mockResolvedValue({
			id: "bot_1",
			status: "scheduled",
		});

		const result = await scheduleMeetingBot({
			orgId,
			meetingUrl: "https://zoom.us/j/123",
		});

		expect(result).toEqual({ id: "bot_1", status: "scheduled" });
		expect(mocks.scheduleManualMeetingBot).toHaveBeenCalledWith(
			expect.objectContaining({
				orgId,
				userId,
				meetingUrl: "https://zoom.us/j/123",
			}),
		);
	});
});

describe("listMeetingBots", () => {
	const buildQuery = (rows: unknown[]) => ({
		from: () => ({
			leftJoin: () => ({
				where: () => ({
					orderBy: () => ({
						limit: () => Promise.resolve(rows),
					}),
				}),
			}),
		}),
	});

	it("marks videoReady when a video exists with no pending upload", async () => {
		mocks.db.mockReturnValue({
			select: () =>
				buildQuery([
					{
						id: "bot_1",
						title: "Standup",
						meetingUrl: "https://zoom.us/j/123",
						joinAt: new Date("2026-09-03T10:00:00.000Z"),
						source: "manual",
						status: "complete",
						errorMessage: null,
						videoId: "video_1",
						createdAt: new Date("2026-09-03T09:00:00.000Z"),
						pendingUploadVideoId: null,
					},
					{
						id: "bot_2",
						title: "Retro",
						meetingUrl: "https://zoom.us/j/456",
						joinAt: new Date("2026-09-03T11:00:00.000Z"),
						source: "manual",
						status: "importing",
						errorMessage: null,
						videoId: "video_2",
						createdAt: new Date("2026-09-03T09:30:00.000Z"),
						pendingUploadVideoId: "video_2",
					},
					{
						id: "bot_3",
						title: "No video yet",
						meetingUrl: "https://zoom.us/j/789",
						joinAt: new Date("2026-09-03T12:00:00.000Z"),
						source: "manual",
						status: "scheduled",
						errorMessage: null,
						videoId: null,
						createdAt: new Date("2026-09-03T09:45:00.000Z"),
						pendingUploadVideoId: null,
					},
				]),
		});

		const rows = await listMeetingBots({ orgId });

		expect(rows.find((row) => row.id === "bot_1")?.videoReady).toBe(true);
		expect(rows.find((row) => row.id === "bot_2")?.videoReady).toBe(false);
		expect(rows.find((row) => row.id === "bot_3")?.videoReady).toBe(false);
		expect(rows[0]).not.toHaveProperty("pendingUploadVideoId");
	});
});
