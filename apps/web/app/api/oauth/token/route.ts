import { headers } from "next/headers";
import {
	oauthCorsHeaders,
	oauthErrorBody,
	oauthJsonHeaders,
	parseOauthFormBody,
} from "@/lib/oauth";
import {
	exchangeOauthAuthorizationCode,
	rotateOauthRefreshToken,
} from "@/lib/oauth-grants";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export function OPTIONS() {
	return new Response(null, { status: 204, headers: oauthCorsHeaders });
}

export async function POST(request: Request) {
	const headerList = await headers();
	const ip =
		headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		headerList.get("x-real-ip") ||
		"unknown";
	if (
		await isRateLimited(RATE_LIMIT_IDS.OAUTH_TOKEN, {
			key: `oauth-token:${ip}`,
			headers: headerList,
		})
	) {
		return Response.json(
			oauthErrorBody("invalid_request", "Too many requests"),
			{
				status: 429,
				headers: oauthJsonHeaders,
			},
		);
	}

	const form = parseOauthFormBody(new URLSearchParams(await request.text()));

	if (!form.clientId) {
		return Response.json(
			oauthErrorBody("invalid_request", "client_id is required"),
			{
				status: 400,
				headers: oauthJsonHeaders,
			},
		);
	}

	if (form.grantType === "authorization_code") {
		if (!form.code || !form.codeVerifier || !form.redirectUri) {
			return Response.json(
				oauthErrorBody(
					"invalid_request",
					"code, code_verifier, and redirect_uri are required",
				),
				{ status: 400, headers: oauthJsonHeaders },
			);
		}
		const result = await exchangeOauthAuthorizationCode({
			code: form.code,
			codeVerifier: form.codeVerifier,
			redirectUri: form.redirectUri,
			clientId: form.clientId,
			clientSecret: form.clientSecret,
		});
		if (!result.ok) {
			return Response.json(oauthErrorBody(result.error, result.description), {
				status: result.status,
				headers: oauthJsonHeaders,
			});
		}
		return Response.json(result.body, { headers: oauthJsonHeaders });
	}

	if (form.grantType === "refresh_token") {
		if (!form.refreshToken) {
			return Response.json(
				oauthErrorBody("invalid_request", "refresh_token is required"),
				{ status: 400, headers: oauthJsonHeaders },
			);
		}
		const result = await rotateOauthRefreshToken({
			refreshToken: form.refreshToken,
			clientId: form.clientId,
			clientSecret: form.clientSecret,
		});
		if (!result.ok) {
			return Response.json(oauthErrorBody(result.error, result.description), {
				status: result.status,
				headers: oauthJsonHeaders,
			});
		}
		return Response.json(result.body, { headers: oauthJsonHeaders });
	}

	return Response.json(
		oauthErrorBody("unsupported_grant_type", "grant_type is not supported"),
		{ status: 400, headers: oauthJsonHeaders },
	);
}
