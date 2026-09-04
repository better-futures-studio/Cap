import * as Sentry from "@sentry/nextjs";

export function sentryTracesSampleRate(): number {
	const raw = process.env.SENTRY_TRACES_SAMPLE_RATE;
	if (raw === undefined || raw === "") return 0.1;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : 0.1;
}

export function captureError(
	error: unknown,
	context?: Record<string, unknown>,
) {
	if (Sentry.getClient()) {
		Sentry.captureException(error, context ? { extra: context } : undefined);
		return;
	}

	console.error(error, context);
}
