import { buildEnv } from "@cap/env";
import * as Sentry from "@sentry/nextjs";
import { sentryTracesSampleRate } from "./lib/monitoring";

const dsn = buildEnv.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
	Sentry.init({
		dsn,
		environment: process.env.SENTRY_ENVIRONMENT || "production",
		tracesSampleRate: sentryTracesSampleRate(),
		sendDefaultPii: false,
		replaysSessionSampleRate: 0,
	});
}
