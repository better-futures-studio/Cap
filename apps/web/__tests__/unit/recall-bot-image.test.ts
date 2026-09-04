import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBotVideoOutput } from "@/lib/recall/bot-image";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const JPEG_B64 = Buffer.from(JPEG_BYTES).toString("base64");
const BOT_IMAGE_URL =
	"https://cap.example.com/api/meeting-bot/card?orgId=org_1";

function imageResponse(
	body: Uint8Array,
	headers: Record<string, string> = { "content-type": "image/jpeg" },
	status = 200,
) {
	return new Response(Buffer.from(body), { status, headers });
}

describe("loadBotVideoOutput", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns jpeg bytes as base64 automatic_video_output", async () => {
		const fetchMock = vi.fn(async () => imageResponse(JPEG_BYTES));
		const cache = new Map<string, string>();

		const result = await loadBotVideoOutput(
			{ botImageUrl: BOT_IMAGE_URL },
			{ fetch: fetchMock, cache },
		);

		expect(result).toEqual({
			in_call_recording: { kind: "jpeg", b64_data: JPEG_B64 },
		});
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(BOT_IMAGE_URL);
	});

	it("accepts jpeg magic bytes when content-type is missing", async () => {
		const fetchMock = vi.fn(async () => imageResponse(JPEG_BYTES, {}));
		const cache = new Map<string, string>();

		const result = await loadBotVideoOutput(
			{ botImageUrl: BOT_IMAGE_URL },
			{ fetch: fetchMock, cache },
		);

		expect(result).toEqual({
			in_call_recording: { kind: "jpeg", b64_data: JPEG_B64 },
		});
	});

	it("does not refetch a cached url", async () => {
		const fetchMock = vi.fn(async () => imageResponse(JPEG_BYTES));
		const cache = new Map<string, string>();
		const config = { botImageUrl: BOT_IMAGE_URL };

		const first = await loadBotVideoOutput(config, {
			fetch: fetchMock,
			cache,
		});
		const second = await loadBotVideoOutput(config, {
			fetch: fetchMock,
			cache,
		});

		expect(first).toEqual(second);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("returns null for a non-jpeg payload", async () => {
		const fetchMock = vi.fn(async () =>
			imageResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
				"content-type": "image/png",
			}),
		);

		const result = await loadBotVideoOutput(
			{ botImageUrl: BOT_IMAGE_URL },
			{ fetch: fetchMock, cache: new Map() },
		);

		expect(result).toBeNull();
		expect(console.warn).toHaveBeenCalledWith(
			"[recall] bot image unavailable",
			{ status: 200, reason: "not_jpeg" },
		);
	});

	it("returns null when the image is over 1.3 MB", async () => {
		const oversize = new Uint8Array(1_300_001);
		oversize[0] = 0xff;
		oversize[1] = 0xd8;
		oversize[2] = 0xff;
		const fetchMock = vi.fn(async () => imageResponse(oversize));

		const result = await loadBotVideoOutput(
			{ botImageUrl: BOT_IMAGE_URL },
			{ fetch: fetchMock, cache: new Map() },
		);

		expect(result).toBeNull();
		expect(console.warn).toHaveBeenCalledWith(
			"[recall] bot image unavailable",
			{ status: 200, reason: "oversize" },
		);
	});

	it("returns null when fetch throws", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network down");
		});

		const result = await loadBotVideoOutput(
			{ botImageUrl: BOT_IMAGE_URL },
			{ fetch: fetchMock, cache: new Map() },
		);

		expect(result).toBeNull();
		expect(console.warn).toHaveBeenCalledWith(
			"[recall] bot image unavailable",
			{ status: undefined, reason: "fetch_failed" },
		);
	});
});
