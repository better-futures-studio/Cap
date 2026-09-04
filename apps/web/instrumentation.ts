import * as Sentry from "@sentry/nextjs";
import { OTLPHttpJsonTraceExporter, registerOTel } from "@vercel/otel";

export async function register() {
	if (process.env.NEXT_PUBLIC_AXIOM_TOKEN) {
		registerOTel({
			serviceName: "cap-web-backend",
			traceExporter: new OTLPHttpJsonTraceExporter({
				url: "https://api.axiom.co/v1/traces",
				headers: {
					Authorization: `Bearer ${process.env.NEXT_PUBLIC_AXIOM_TOKEN}`,
					"X-Axiom-Dataset": process.env.NEXT_PUBLIC_AXIOM_DATASET,
				},
			}),
		});
	} else if (process.env.NODE_ENV === "development") {
		registerOTel({
			serviceName: "cap-web-backend",
			traceExporter: new OTLPHttpJsonTraceExporter({}),
		});
	}

	if (process.env.NEXT_RUNTIME === "nodejs") {
		await import("./sentry.server.config");
		const { register } = await import("./instrumentation.node");
		await register();
	}

	if (process.env.NEXT_RUNTIME === "edge") {
		await import("./sentry.edge.config");
	}
}

export function onRequestError(
	...args: Parameters<typeof Sentry.captureRequestError>
) {
	if (Sentry.getClient()) {
		Sentry.captureRequestError(...args);
	}
}
