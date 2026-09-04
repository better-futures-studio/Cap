import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { captureError } from "@/lib/monitoring";
import { reconcileRecallMeetingBots } from "@/lib/recall/reconcile";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	const authHeader = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;
	if (
		!authHeader ||
		authHeader.length !== expected.length ||
		!timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const result = await reconcileRecallMeetingBots();
		if (!result) {
			return NextResponse.json(
				{ error: "Recall is not configured" },
				{ status: 503 },
			);
		}

		return NextResponse.json({ success: true, ...result });
	} catch (error) {
		captureError(error, { route: "recall-reconcile" });
		return NextResponse.json(
			{ error: "Reconciliation failed" },
			{ status: 500 },
		);
	}
}
