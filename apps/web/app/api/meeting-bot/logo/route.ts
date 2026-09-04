import type { NextRequest } from "next/server";
import {
	loadBotCardOrganization,
	resolveCardIcon,
} from "@/lib/recall/bot-card";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const orgId = req.nextUrl.searchParams.get("orgId");
	if (!orgId) return new Response("Missing orgId", { status: 400 });
	const org = await loadBotCardOrganization(orgId);
	const icon = org ? await resolveCardIcon(orgId, org.iconUrl) : null;
	if (!icon) return new Response("Not found", { status: 404 });
	return new Response(new Uint8Array(icon), {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
