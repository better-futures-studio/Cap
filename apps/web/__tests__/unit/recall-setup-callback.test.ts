import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ serverEnv: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: mocks.serverEnv }));

import { GET } from "@/app/api/integrations/recall-calendar/setup-callback/route";

function makeRequest(query: string) {
	return new NextRequest(
		`https://cap.boca.pro/api/integrations/recall-calendar/setup-callback${query}`,
	);
}

describe("recall calendar setup-callback forwarder", () => {
	beforeEach(() => {
		mocks.serverEnv.mockReturnValue({
			RECALL_CALENDAR_SETUP_CALLBACK_URI:
				"https://us-west-2.recall.ai/api/internal/calendar-integration/setup/oauth-callback/",
			RECALL_REGION: "us-west-2",
		});
	});

	it("forwards state and code, dropping unexpected params", async () => {
		const response = await GET(makeRequest("?state=abc&code=xyz&unexpected=1"));
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.origin + location.pathname).toBe(
			"https://us-west-2.recall.ai/api/internal/calendar-integration/setup/oauth-callback/",
		);
		expect(location.searchParams.get("state")).toBe("abc");
		expect(location.searchParams.get("code")).toBe("xyz");
		expect(location.searchParams.has("unexpected")).toBe(false);
		expect(location.searchParams.has("error")).toBe(false);
	});

	it("forwards state and error", async () => {
		const response = await GET(makeRequest("?state=abc&error=access_denied"));
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.searchParams.get("error")).toBe("access_denied");
		expect(location.searchParams.has("code")).toBe(false);
	});

	it("returns 400 when state is missing", async () => {
		const response = await GET(makeRequest("?code=xyz"));
		expect(response.status).toBe(400);
	});

	it("returns 400 when both code and error are present", async () => {
		const response = await GET(makeRequest("?state=abc&code=xyz&error=oops"));
		expect(response.status).toBe(400);
	});

	it("returns 400 when none of code, error, or probe are present", async () => {
		const response = await GET(makeRequest("?state=abc"));
		expect(response.status).toBe(400);
	});

	it("derives the callback url from RECALL_REGION when the env var is unset", async () => {
		mocks.serverEnv.mockReturnValue({ RECALL_REGION: "eu-west-1" });
		const response = await GET(
			makeRequest("?state=abc&recall_calendar_setup_probe=1"),
		);
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.origin + location.pathname).toBe(
			"https://eu-west-1.recall.ai/api/internal/calendar-integration/setup/oauth-callback/",
		);
		expect(location.searchParams.get("recall_calendar_setup_probe")).toBe("1");
	});

	it("defaults to us-west-2 when neither env var is set", async () => {
		mocks.serverEnv.mockReturnValue({});
		const response = await GET(makeRequest("?state=abc&code=xyz"));
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.origin + location.pathname).toBe(
			"https://us-west-2.recall.ai/api/internal/calendar-integration/setup/oauth-callback/",
		);
	});
});
