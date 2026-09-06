import { serverEnv } from "@cap/env";
import {
	oauthAuthorizationServerMetadata,
	oauthCorsHeaders,
	oauthJsonHeaders,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";

export function OPTIONS() {
	return new Response(null, { status: 204, headers: oauthCorsHeaders });
}

export function GET() {
	return Response.json(oauthAuthorizationServerMetadata(serverEnv().WEB_URL), {
		headers: oauthJsonHeaders,
	});
}
