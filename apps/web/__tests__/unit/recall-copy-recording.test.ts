import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	writePath: "",
	unlinked: [] as string[],
	createWriteStream: vi.fn((path: string) => {
		mocks.writePath = path;
		return { path };
	}),
	createReadStream: vi.fn((path: string) => ({ path })),
	stat: vi.fn(async () => ({ size: 12 })),
	unlink: vi.fn(async (path: string) => {
		mocks.unlinked.push(path);
	}),
	pipeline: vi.fn(async () => undefined),
	fromWeb: vi.fn((body: unknown) => ({ kind: "fromWeb", body })),
	toWeb: vi.fn((stream: unknown) => ({ kind: "toWeb", stream })),
	tmpdir: vi.fn(() => "/tmp"),
}));

vi.mock("node:os", () => ({
	tmpdir: mocks.tmpdir,
}));
vi.mock("node:fs", () => ({
	createWriteStream: mocks.createWriteStream,
	createReadStream: mocks.createReadStream,
}));
vi.mock("node:fs/promises", () => ({
	stat: mocks.stat,
	unlink: mocks.unlink,
}));
vi.mock("node:stream/promises", () => ({
	pipeline: mocks.pipeline,
}));
vi.mock("node:stream", () => ({
	Readable: {
		fromWeb: mocks.fromWeb,
		toWeb: mocks.toWeb,
	},
}));

const { copyRemoteVideoToPresignedPut } = await import(
	"@/lib/recall/copy-recording"
);

function downloadResponse({
	ok = true,
	status = 200,
	contentType = "video/mp4",
	contentLength,
	body = {},
}: {
	ok?: boolean;
	status?: number;
	contentType?: string;
	contentLength?: string;
	body?: unknown;
} = {}) {
	const headers = new Headers({ "content-type": contentType });
	if (contentLength !== undefined) {
		headers.set("content-length", contentLength);
	}
	return {
		ok,
		status,
		headers,
		body,
	} as Response;
}

describe("copyRemoteVideoToPresignedPut", () => {
	beforeEach(() => {
		mocks.writePath = "";
		mocks.unlinked = [];
		mocks.createWriteStream.mockClear();
		mocks.createReadStream.mockClear();
		mocks.stat.mockClear();
		mocks.unlink.mockClear();
		mocks.pipeline.mockClear();
		mocks.fromWeb.mockClear();
		mocks.toWeb.mockClear();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://recall.example/video.mp4") {
					return downloadResponse({ contentLength: "12", body: "download" });
				}
				if (url === "https://r2.example/put" && init?.method === "PUT") {
					return { ok: true, status: 200 } as Response;
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("writes the download to a temp file and removes it after upload", async () => {
		await expect(
			copyRemoteVideoToPresignedPut({
				downloadUrl: "https://recall.example/video.mp4",
				putUrl: "https://r2.example/put",
			}),
		).resolves.toBe(12);

		expect(mocks.pipeline).toHaveBeenCalled();
		expect(mocks.writePath).toMatch(/^\/tmp\/recall-recording-.*\.mp4$/);
		expect(mocks.createWriteStream).toHaveBeenCalledWith(mocks.writePath);
		expect(mocks.createReadStream).toHaveBeenCalledWith(mocks.writePath);
		expect(mocks.unlinked).toEqual([mocks.writePath]);
		expect(fetch).toHaveBeenCalledWith(
			"https://r2.example/put",
			expect.objectContaining({
				method: "PUT",
				headers: {
					"Content-Type": "video/mp4",
					"Content-Length": "12",
				},
				duplex: "half",
			}),
		);
	});

	it("removes the temp file when upload fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url === "https://recall.example/video.mp4") {
					return downloadResponse({ contentLength: "12", body: "download" });
				}
				return { ok: false, status: 500 } as Response;
			}),
		);

		await expect(
			copyRemoteVideoToPresignedPut({
				downloadUrl: "https://recall.example/video.mp4",
				putUrl: "https://r2.example/put",
			}),
		).rejects.toThrow("Recording upload failed (500)");
		expect(mocks.unlinked).toEqual([mocks.writePath]);
	});
});
