import * as Sentry from "@sentry/nextjs";
import { sentryTracesSampleRate } from "./lib/monitoring";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
	Sentry.init({
		dsn,
		environment: process.env.SENTRY_ENVIRONMENT || "production",
		tracesSampleRate: sentryTracesSampleRate(),
		sendDefaultPii: false,
	});
}
