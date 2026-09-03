import { describe, expect, it, vi } from "vitest";
import {
	buildGoogleCalendarAuthUrl,
	exchangeGoogleCode,
} from "@/lib/recall/calendar-oauth";

describe("buildGoogleCalendarAuthUrl", () => {
	it("requests the two calendar scopes with offline access and consent", () => {
		const url = new URL(
			buildGoogleCalendarAuthUrl({
				clientId: "client-id",
				redirectUri:
					"https://cap.boca.pro/api/integrations/recall-calendar/callback",
				state: "signed-state",
			}),
		);

		expect(url.origin + url.pathname).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(url.searchParams.get("client_id")).toBe("client-id");
		expect(url.searchParams.get("state")).toBe("signed-state");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent select_account");
		expect(url.searchParams.get("include_granted_scopes")).toBe("false");
		const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
		expect(scopes).toContain(
			"https://www.googleapis.com/auth/calendar.events.readonly",
		);
		expect(scopes).toContain("https://www.googleapis.com/auth/userinfo.email");
	});
});

describe("exchangeGoogleCode", () => {
	it("posts the expected form fields and returns the tokens", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					refresh_token: "refresh-1",
					access_token: "access-1",
				}),
				{ status: 200 },
			),
		);

		const result = await exchangeGoogleCode({
			code: "auth-code",
			clientId: "client-id",
			clientSecret: "client-secret",
			redirectUri:
				"https://cap.boca.pro/api/integrations/recall-calendar/callback",
			fetch: fetchImpl,
		});

		expect(result).toEqual({
			refreshToken: "refresh-1",
			accessToken: "access-1",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://oauth2.googleapis.com/token");
		expect(init.method).toBe("POST");
		const body = new URLSearchParams(init.body as string);
		expect(body.get("code")).toBe("auth-code");
		expect(body.get("client_id")).toBe("client-id");
		expect(body.get("client_secret")).toBe("client-secret");
		expect(body.get("redirect_uri")).toBe(
			"https://cap.boca.pro/api/integrations/recall-calendar/callback",
		);
		expect(body.get("grant_type")).toBe("authorization_code");
	});

	it("throws a specific error when Google does not return a refresh token", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ access_token: "access-1" }), {
				status: 200,
			}),
		);

		await expect(
			exchangeGoogleCode({
				code: "auth-code",
				clientId: "client-id",
				clientSecret: "client-secret",
				redirectUri:
					"https://cap.boca.pro/api/integrations/recall-calendar/callback",
				fetch: fetchImpl,
			}),
		).rejects.toThrow(/did not return a refresh token/);
	});

	it("throws when the token endpoint responds with an error status", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: "invalid_grant" }), {
				status: 400,
			}),
		);

		await expect(
			exchangeGoogleCode({
				code: "auth-code",
				clientId: "client-id",
				clientSecret: "client-secret",
				redirectUri:
					"https://cap.boca.pro/api/integrations/recall-calendar/callback",
				fetch: fetchImpl,
			}),
		).rejects.toThrow(/token exchange failed/);
	});
});
