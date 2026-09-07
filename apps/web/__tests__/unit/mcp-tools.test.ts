import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMeetingSearchFilters } from "@/lib/mcp-tools";
import {
	formatTranscriptText,
	parseVttCuesWithSpeakers,
	trimTranscriptCues,
} from "@/lib/mcp-transcript";
import { mcpWwwAuthenticate } from "@/lib/oauth";

const mocks = vi.hoisted(() => ({
	authenticateMcpBearer: vi.fn(),
	handleMcpRequest: vi.fn(),
	webUrl: "https://cap.example",
}));

vi.mock("server-only", () => ({}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: mocks.webUrl }),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				leftJoin: () => ({
					where: () => ({
						orderBy: () => ({ limit: async () => [] }),
					}),
				}),
				innerJoin: () => ({
					where: () => ({ limit: async () => [] }),
				}),
				where: () => ({ limit: async () => [] }),
			}),
		}),
	}),
}));

vi.mock("@cap/web-backend", () => ({
	VideosPolicy: {},
	Storage: { getAccessForVideo: vi.fn() },
	shouldRefreshAgentLastUsedAt: () => false,
}));

vi.mock("@/lib/server", () => ({
	runPromise: vi.fn(),
	runPromiseExit: vi.fn(),
}));

vi.mock("@/lib/mcp-auth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/mcp-auth")>();
	return {
		...actual,
		authenticateMcpBearer: mocks.authenticateMcpBearer,
	};
});

vi.mock("@/lib/mcp-server", () => ({
	handleMcpRequest: mocks.handleMcpRequest,
}));

const sampleVtt = `WEBVTT

1
00:00:00.000 --> 00:00:05.000
Ada: Hello from the start

2
00:00:10.000 --> 00:00:15.000
Ben: Middle of the call

3
00:00:40.000 --> 00:00:50.000
Ada: Closing remarks
`;

type SearchRow = Parameters<typeof applyMeetingSearchFilters>[0][number];

function searchRow(id: string, title: string): SearchRow {
	return {
		id,
		name: title,
		createdAt: new Date("2026-09-01T12:00:00.000Z"),
		duration: 120,
		metadata: { summary: `${title} summary` },
		meetingTitle: title,
		meetingUrl: "https://meet.google.com/abc-defg-hij",
		joinAt: new Date("2026-09-01T12:00:00.000Z"),
		source: "google_calendar" as const,
		calendarEventId: null,
		attendeeEmails: null,
		attendeeNames: null,
		attendees: ["ada@boca.pro"],
	} as unknown as SearchRow;
}

describe("search_meetings scoping", () => {
	it("never returns a video the user cannot view", () => {
		const hits = applyMeetingSearchFilters(
			[
				searchRow("allowed", "Weekly standup meeting"),
				searchRow("secret", "Secret board meeting"),
			],
			new Set(["allowed"]),
			{ query: "meeting", meetingsOnly: true },
		);
		expect(hits.map((hit) => hit.id)).toEqual(["allowed"]);
		expect(hits.some((hit) => hit.id === "secret")).toBe(false);
	});
});

describe("get_transcript range trimming", () => {
	it("keeps cues that overlap the requested window", () => {
		const cues = trimTranscriptCues(parseVttCuesWithSpeakers(sampleVtt), 8, 20);
		expect(cues.map((cue) => cue.text)).toEqual(["Middle of the call"]);
		expect(formatTranscriptText(cues)).toContain("Ben: Middle of the call");
	});
});

describe("POST /api/mcp unauthenticated", () => {
	beforeEach(() => {
		mocks.authenticateMcpBearer.mockReset();
		mocks.handleMcpRequest.mockReset();
	});

	it("returns 401 with the protected-resource WWW-Authenticate header", async () => {
		mocks.authenticateMcpBearer.mockResolvedValue(null);
		const { POST } = await import("@/app/api/mcp/route");
		const response = await POST(
			new Request("https://cap.example/api/mcp", { method: "POST" }),
		);
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toBe(
			mcpWwwAuthenticate(mocks.webUrl),
		);
		expect(response.headers.get("WWW-Authenticate")).toBe(
			`Bearer resource_metadata="${mocks.webUrl}/.well-known/oauth-protected-resource/api/mcp"`,
		);
		expect(mocks.handleMcpRequest).not.toHaveBeenCalled();
	});
});
