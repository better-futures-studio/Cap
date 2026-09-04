import { db } from "@cap/database";
import { recallWebhookEvents } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { after, type NextRequest, NextResponse } from "next/server";
import { captureError } from "@/lib/monitoring";
import { getRecallConfig } from "@/lib/recall/config";
import { handleRealtimeEvent } from "@/lib/recall/realtime";
import { verifyRecallSignature } from "@/lib/recall/verify";

export const dynamic = "force-dynamic";

let loggedPayloadKeys = false;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function affectedRows(result: unknown): number {
	if (Array.isArray(result))
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

function deferChatWork(work: () => Promise<unknown>, event: string) {
	const task = work().catch((error) => {
		captureError(error, { event, source: "chat" });
	});
	try {
		after(task);
	} catch {
		void task;
	}
}

export async function POST(request: NextRequest) {
	const raw = await request.text();
	const config = getRecallConfig();
	if (!config?.verificationSecret)
		return NextResponse.json({ error: "not configured" }, { status: 503 });
	if (
		!verifyRecallSignature({
			secret: config.verificationSecret,
			headers: request.headers,
			payload: raw,
		})
	) {
		return NextResponse.json({ error: "invalid signature" }, { status: 401 });
	}
	let parsed: Record<string, unknown>;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value) || typeof value.event !== "string") throw new Error();
		parsed = value;
	} catch {
		return NextResponse.json({ error: "invalid payload" }, { status: 400 });
	}
	if (!loggedPayloadKeys) {
		loggedPayloadKeys = true;
		console.info("[recall-realtime] payload keys", {
			keys: Object.keys(parsed),
		});
	}
	const event = parsed.event as string;
	const webhookId = request.headers.get("webhook-id");
	try {
		if (webhookId) {
			const inserted = await db()
				.insert(recallWebhookEvents)
				.ignore()
				.values({ id: webhookId, event });
			if (affectedRows(inserted) === 0)
				return NextResponse.json({ duplicate: true });
		}
		await handleRealtimeEvent(
			{ event, data: parsed.data },
			{
				deferChat: (work) => deferChatWork(work, event),
			},
		);
		return NextResponse.json({ accepted: true });
	} catch (error) {
		if (webhookId) {
			await db()
				.delete(recallWebhookEvents)
				.where(eq(recallWebhookEvents.id, webhookId))
				.catch(() => undefined);
		}
		captureError(error, { event });
		return NextResponse.json({ accepted: false });
	}
}
