import { db } from "@cap/database";
import { headers } from "next/headers";
import {
	oauthCorsHeaders,
	oauthJsonHeaders,
	registerOauthClient,
} from "@/lib/oauth";
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
		await isRateLimited(RATE_LIMIT_IDS.OAUTH_REGISTER, {
			key: `oauth-register:${ip}`,
			headers: headerList,
		})
	) {
		return Response.json(
			{ error: "invalid_request", error_description: "Too many requests" },
			{ status: 429, headers: oauthJsonHeaders },
		);
	}

	let body: unknown = {};
	try {
		body = await request.json();
	} catch {
		body = {};
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json(
			{
				error: "invalid_client_metadata",
				error_description: "JSON object required",
			},
			{ status: 400, headers: oauthJsonHeaders },
		);
	}

	const result = await registerOauthClient(db(), body);
	return Response.json(result.body, {
		status: result.status,
		headers: oauthJsonHeaders,
	});
}
