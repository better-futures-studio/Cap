import { db } from "@cap/database";
import { recallWebhookEvents } from "@cap/database/schema";
import { type NextRequest, NextResponse } from "next/server";
import { captureError } from "@/lib/monitoring";
import { getRecallConfig } from "@/lib/recall/config";
import { verifyRecallSignature } from "@/lib/recall/verify";
import { dispatchRecallWebhook } from "@/lib/recall/webhooks";

export const dynamic = "force-dynamic";

function getAffectedRows(result: unknown): number {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function webhookIdFrom(headers: Headers): string {
	return headers.get("webhook-id") ?? headers.get("svix-id") ?? "missing";
}

export async function POST(request: NextRequest) {
	const raw = await request.text();
	const config = getRecallConfig();
	if (!config?.verificationSecret) {
		return NextResponse.json({ error: "not configured" }, { status: 503 });
	}

	const webhookId = webhookIdFrom(request.headers);
	if (
		!verifyRecallSignature({
			secret: config.verificationSecret,
			headers: request.headers,
			payload: raw,
		})
	) {
		console.warn("[recall-webhook] rejected", { id: webhookId });
		return NextResponse.json({ error: "invalid signature" }, { status: 401 });
	}

	let payload: { event: string; data: unknown };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.event !== "string") {
			return NextResponse.json({ error: "invalid payload" }, { status: 400 });
		}
		payload = { event: parsed.event, data: parsed.data };
	} catch {
		return NextResponse.json({ error: "invalid payload" }, { status: 400 });
	}

	if (webhookId === "missing") {
		return NextResponse.json({ error: "invalid signature" }, { status: 401 });
	}

	const insertResult = await db().insert(recallWebhookEvents).ignore().values({
		id: webhookId,
		event: payload.event,
	});

	if (getAffectedRows(insertResult) === 0) {
		return NextResponse.json({ duplicate: true });
	}

	try {
		await dispatchRecallWebhook(payload);
		return NextResponse.json({ accepted: true });
	} catch (error) {
		captureError(error, {
			event: payload.event,
			id: webhookId,
		});
		return NextResponse.json({ accepted: false });
	}
}
