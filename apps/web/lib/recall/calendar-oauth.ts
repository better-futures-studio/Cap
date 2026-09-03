const GOOGLE_CALENDAR_SCOPES = [
	"https://www.googleapis.com/auth/calendar.events.readonly",
	"https://www.googleapis.com/auth/userinfo.email",
].join(" ");

export function buildGoogleCalendarAuthUrl({
	clientId,
	redirectUri,
	state,
}: {
	clientId: string;
	redirectUri: string;
	state: string;
}): string {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES);
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent select_account");
	url.searchParams.set("include_granted_scopes", "false");
	url.searchParams.set("state", state);
	return url.toString();
}

export type GoogleTokenExchangeResult = {
	refreshToken: string;
	accessToken: string;
};

type GoogleTokenResponseBody = {
	refresh_token?: string;
	access_token?: string;
	error?: string;
	error_description?: string;
};

export async function exchangeGoogleCode({
	code,
	clientId,
	clientSecret,
	redirectUri,
	fetch: fetchImpl = fetch,
}: {
	code: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	fetch?: typeof fetch;
}): Promise<GoogleTokenExchangeResult> {
	const response = await fetchImpl("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}),
	});

	let body: GoogleTokenResponseBody | null = null;
	try {
		body = (await response.json()) as GoogleTokenResponseBody;
	} catch {
		body = null;
	}

	if (!response.ok || !body) {
		throw new Error(`Google OAuth token exchange failed (${response.status})`);
	}
	if (!body.refresh_token) {
		throw new Error(
			"Google did not return a refresh token; remove Cap from your Google account's connected apps and try again",
		);
	}
	if (typeof body.access_token !== "string") {
		throw new Error(
			"Google OAuth token exchange did not return an access token",
		);
	}

	return { refreshToken: body.refresh_token, accessToken: body.access_token };
}

export async function fetchGoogleUserEmail({
	accessToken,
	fetch: fetchImpl = fetch,
}: {
	accessToken: string;
	fetch?: typeof fetch;
}): Promise<string | null> {
	try {
		const response = await fetchImpl(
			"https://www.googleapis.com/oauth2/v3/userinfo",
			{ headers: { authorization: `Bearer ${accessToken}` } },
		);
		if (!response.ok) return null;
		const body = (await response.json()) as { email?: string };
		return typeof body.email === "string" ? body.email : null;
	} catch {
		return null;
	}
}
