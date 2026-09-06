import { serverEnv } from "@cap/env";
import { authenticateMcpBearer } from "@/lib/mcp-auth";
import { handleMcpRequest } from "@/lib/mcp-server";
import {
	mcpWwwAuthenticate,
	oauthCorsHeaders,
	oauthJsonHeaders,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";

const unauthorizedHeaders = () => ({
	...oauthJsonHeaders,
	"WWW-Authenticate": mcpWwwAuthenticate(serverEnv().WEB_URL),
});

export function OPTIONS() {
	return new Response(null, { status: 204, headers: oauthCorsHeaders });
}

export function GET() {
	return new Response("Method Not Allowed", {
		status: 405,
		headers: {
			...oauthCorsHeaders,
			Allow: "POST, OPTIONS",
		},
	});
}

export async function POST(request: Request) {
	const principal = await authenticateMcpBearer(
		request.headers.get("authorization"),
	);
	if (!principal) {
		return Response.json(
			{
				error: "invalid_token",
				error_description: "A valid Bearer token is required",
			},
			{ status: 401, headers: unauthorizedHeaders() },
		);
	}
	const response = await handleMcpRequest(request, principal);
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(oauthCorsHeaders)) {
		headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		headers,
	});
}
