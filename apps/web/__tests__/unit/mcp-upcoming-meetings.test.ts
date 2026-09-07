import type { Agent, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpPrincipal } from "@/lib/mcp-auth";
import { listUpcomingMeetings } from "@/lib/mcp-tools";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	meetingBotIdsAccessibleToUser: vi.fn(
		async ({ bots }: { bots: { id: string }[] }) =>
			new Set(bots.map((bot) => bot.id)),
	),
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
			"ownerId",
			"recallBotId",
			"videoId",
			"calendarEventId",
			"statusSubCode",
			"attendeeEmails",
			"title",
			"joinAt",
			"meetingUrl",
			"source",
			"status",
		]),
		comments: table("comments", ["id", "videoId"]),
		users: table("users", ["id", "email", "name"]),
		videoShares: table("video_shares", ["videoId", "userId"]),
		videos: table("videos", ["id"]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
	gte: (column: string, value: unknown) => ({ op: "gte", column, value }),
	lte: (column: string, value: unknown) => ({ op: "lte", column, value }),
	inArray: (column: string, values: unknown[]) => ({
		op: "inArray",
		column,
		values,
	}),
	desc: (column: string) => column,
	sql: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.example" }),
}));
vi.mock("@/lib/recall/visibility", () => ({
	meetingBotIdsAccessibleToUser: mocks.meetingBotIdsAccessibleToUser,
	hydrateCalendarAttendees: vi.fn(),
	storedStringArray: (value: unknown) =>
		Array.isArray(value)
			? value.filter((item) => typeof item === "string")
			: null,
}));
vi.mock("@/lib/mcp-access", () => ({
	listAccessibleVideoIds: vi.fn(async () => new Set()),
	loadViewableVideo: vi.fn(),
}));
vi.mock("@/lib/mcp-ask", () => ({
	askRecordingForUser: vi.fn(),
	loadTranscriptVtt: vi.fn(),
}));

const ownerId = "user_1" as User.UserId;
const otherId = "user_2" as User.UserId;
const joinAt = new Date("2026-09-10T15:00:00.000Z");
const meetingUrl = "https://meet.google.com/abc-defg-hij";

const principal: McpPrincipal = {
	id: ownerId,
	email: "ada@example.com",
	activeOrganizationId: "org_1" as never,
	scopes: new Set<Agent.AgentScope>(["meetings:read"]),
	tokenId: "tok_1",
	expiresAt: new Date("2026-12-01T00:00:00.000Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.meetingBotIdsAccessibleToUser.mockImplementation(
		async ({ bots }: { bots: { id: string }[] }) =>
			new Set(bots.map((bot) => bot.id)),
	);
});

describe("listUpcomingMeetings", () => {
	it("collapses rows that share meetingUrl and joinAt, preferring the owned row", async () => {
		const bots = [
			{
				id: "other_bot",
				ownerId: otherId,
				recallBotId: "recall_other",
				videoId: null,
				calendarEventId: "evt_other",
				statusSubCode: null,
				attendeeEmails: ["ada@example.com"],
				title: "Standup",
				joinAt,
				meetingUrl,
				source: "calendar",
				status: "scheduled",
			},
			{
				id: "owned_bot",
				ownerId,
				recallBotId: "recall_owned",
				videoId: null,
				calendarEventId: "evt_owned",
				statusSubCode: null,
				attendeeEmails: ["ada@example.com"],
				title: "Standup",
				joinAt,
				meetingUrl,
				source: "calendar",
				status: "scheduled",
			},
		];
		mocks.db.mockReturnValue({
			select: () => ({
				from: () => ({
					where: () => ({
						orderBy: () => ({
							limit: async () => bots,
						}),
					}),
				}),
			}),
		});

		const result = await listUpcomingMeetings(principal, 7);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("owned_bot");
		expect(result[0]?.meetingUrl).toBe(meetingUrl);
	});
});
