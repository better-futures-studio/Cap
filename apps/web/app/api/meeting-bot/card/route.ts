import type { NextRequest } from "next/server";
import { meetingBotCardResponse } from "@/lib/recall/bot-card";

export async function GET(req: NextRequest) {
	return meetingBotCardResponse(req.nextUrl.searchParams.get("orgId"));
}
