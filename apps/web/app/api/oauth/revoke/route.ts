import { oauthCorsHeaders, parseOauthFormBody } from "@/lib/oauth";
import { revokeOauthToken } from "@/lib/oauth-grants";

export const dynamic = "force-dynamic";

export function OPTIONS() {
	return new Response(null, { status: 204, headers: oauthCorsHeaders });
}

export async function POST(request: Request) {
	const form = parseOauthFormBody(new URLSearchParams(await request.text()));
	if (form.token) {
		await revokeOauthToken({
			token: form.token,
			clientId: form.clientId,
			clientSecret: form.clientSecret,
			tokenTypeHint: form.tokenTypeHint,
		});
	}
	return new Response(null, { status: 200, headers: oauthCorsHeaders });
}
