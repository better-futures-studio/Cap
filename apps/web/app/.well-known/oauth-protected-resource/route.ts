import { serverEnv } from "@cap/env";
import {
	oauthCorsHeaders,
	oauthJsonHeaders,
	oauthProtectedResourceMetadata,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";

export function OPTIONS() {
	return new Response(null, { status: 204, headers: oauthCorsHeaders });
}

export function GET() {
	return Response.json(oauthProtectedResourceMetadata(serverEnv().WEB_URL), {
		headers: oauthJsonHeaders,
	});
}
