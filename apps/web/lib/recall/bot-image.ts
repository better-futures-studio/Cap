import type { RecallAutomaticVideoOutput } from "./client";
import type { RecallConfig } from "./config";

const MAX_BOT_IMAGE_BYTES = 1_300_000;
const defaultCache = new Map<string, string>();

function isJpegMagic(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	);
}

function warnUnavailable(status: number | undefined, reason: string): void {
	console.warn("[recall] bot image unavailable", { status, reason });
}

export async function loadBotVideoOutput(
	config: Pick<RecallConfig, "botImageUrl">,
	deps?: { fetch?: typeof fetch; cache?: Map<string, string> },
): Promise<RecallAutomaticVideoOutput | null> {
	const cache = deps?.cache ?? defaultCache;
	const cached = cache.get(config.botImageUrl);
	if (cached !== undefined) {
		return { in_call_recording: { kind: "jpeg", b64_data: cached } };
	}

	const fetchImpl = deps?.fetch ?? fetch;

	try {
		const response = await fetchImpl(config.botImageUrl);
		if (!response.ok) {
			warnUnavailable(response.status, "http_error");
			return null;
		}

		const contentLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > MAX_BOT_IMAGE_BYTES) {
			warnUnavailable(response.status, "oversize");
			return null;
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_BOT_IMAGE_BYTES) {
			warnUnavailable(response.status, "oversize");
			return null;
		}

		const contentType = response.headers.get("content-type") ?? "";
		const isJpegType = contentType.toLowerCase().includes("image/jpeg");
		if (!isJpegType && !isJpegMagic(bytes)) {
			warnUnavailable(response.status, "not_jpeg");
			return null;
		}

		const b64_data = Buffer.from(bytes).toString("base64");
		cache.set(config.botImageUrl, b64_data);
		return { in_call_recording: { kind: "jpeg", b64_data } };
	} catch {
		warnUnavailable(undefined, "fetch_failed");
		return null;
	}
}
