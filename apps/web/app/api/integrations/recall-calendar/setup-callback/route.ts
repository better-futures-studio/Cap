import { serverEnv } from "@cap/env";
import { type NextRequest, NextResponse } from "next/server";

const FORWARDABLE_PARAMS = [
	"code",
	"error",
	"recall_calendar_setup_probe",
] as const;

function resolveSetupCallbackBaseUrl(): string {
	const env = serverEnv();
	if (env.RECALL_CALENDAR_SETUP_CALLBACK_URI) {
		return env.RECALL_CALENDAR_SETUP_CALLBACK_URI;
	}
	const region = env.RECALL_REGION || "us-west-2";
	return `https://${region}.recall.ai/api/internal/calendar-integration/setup/oauth-callback/`;
}

export async function GET(request: NextRequest) {
	const params = request.nextUrl.searchParams;
	const state = params.get("state");
	const [paramName, ...extra] = FORWARDABLE_PARAMS.filter((name) =>
		params.has(name),
	);

	if (!state || !paramName || extra.length > 0) {
		return NextResponse.json(
			{ error: "invalid setup callback request" },
			{ status: 400 },
		);
	}

	const target = new URL(resolveSetupCallbackBaseUrl());
	target.searchParams.set("state", state);
	const value = params.get(paramName);
	if (value !== null) target.searchParams.set(paramName, value);

	return NextResponse.redirect(target, { status: 302 });
}
