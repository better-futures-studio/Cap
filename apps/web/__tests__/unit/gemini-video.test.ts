import { afterEach, describe, expect, it, vi } from "vitest";

const serverEnvMock = vi.hoisted(() =>
	vi.fn(() => ({
		GOOGLE_GENERATIVE_AI_API_KEY: "test-gemini-key",
		GEMINI_VIDEO_MODEL: "gemini-3.5-flash",
	})),
);

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
}));

import {
	clampGeminiChapters,
	countTranscriptWords,
	describeVideoWithGemini,
	isTranscriptTooShort,
	isVideoUnderstandingEnabled,
	parseGeminiVideoDescription,
	transcriptTextFromVtt,
	uploadVideoToGemini,
	waitForGeminiFile,
} from "@/lib/ai/gemini-video";

function jsonResponse(
	body: unknown,
	init: { status?: number; headers?: Record<string, string> } = {},
) {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: {
			"content-type": "application/json",
			...init.headers,
		},
	});
}

describe("isVideoUnderstandingEnabled", () => {
	it("is true when the Gemini API key is present", () => {
		expect(isVideoUnderstandingEnabled()).toBe(true);
	});

	it("is false when the Gemini API key is missing", () => {
		serverEnvMock.mockReturnValueOnce({
			GOOGLE_GENERATIVE_AI_API_KEY: undefined,
			GEMINI_VIDEO_MODEL: "gemini-3.5-flash",
		} as never);
		expect(isVideoUnderstandingEnabled()).toBe(false);
	});
});

describe("transcript speech helpers", () => {
	it("counts VTT cue words and treats under 20 words as too short", () => {
		const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:02.000
Hello there.

2
00:00:02.000 --> 00:00:04.000
Just a few words.
`;
		const text = transcriptTextFromVtt(vtt);
		expect(text).toBe("Hello there. Just a few words.");
		expect(countTranscriptWords(text)).toBe(6);
		expect(isTranscriptTooShort(text)).toBe(true);
		expect(
			isTranscriptTooShort(
				Array.from({ length: 20 }, (_, index) => `word${index}`).join(" "),
			),
		).toBe(false);
	});
});

describe("uploadVideoToGemini", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("starts a resumable upload and streams the source body without buffering", async () => {
		const sourceBody = new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		});
		const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
			const href = String(url);
			if (href.includes("/upload/v1beta/files")) {
				return jsonResponse(
					{},
					{
						headers: {
							"x-goog-upload-url":
								"https://generativelanguage.googleapis.com/upload/session/1",
						},
					},
				);
			}
			if (href === "https://storage.example/video.mp4") {
				return new Response(sourceBody, { status: 200 });
			}
			return jsonResponse({
				file: {
					name: "files/abc123",
					uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await uploadVideoToGemini({
			sourceUrl: "https://storage.example/video.mp4",
			sizeBytes: 12,
			displayName: "silent.mp4",
		});

		expect(result).toEqual({
			name: "files/abc123",
			uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
		});

		const startCall = fetchMock.mock.calls[0];
		expect(startCall?.[0]).toBe(
			"https://generativelanguage.googleapis.com/upload/v1beta/files",
		);
		expect(startCall?.[1]?.headers).toMatchObject({
			"X-Goog-Upload-Protocol": "resumable",
			"X-Goog-Upload-Command": "start",
			"X-Goog-Upload-Header-Content-Length": "12",
			"X-Goog-Upload-Header-Content-Type": "video/mp4",
			"x-goog-api-key": "test-gemini-key",
		});
		expect(startCall?.[1]?.body).toBe(
			JSON.stringify({ file: { display_name: "silent.mp4" } }),
		);

		const putCall = fetchMock.mock.calls.find(
			(call) =>
				String(call[0]) ===
				"https://generativelanguage.googleapis.com/upload/session/1",
		);
		expect(putCall?.[1]?.headers).toMatchObject({
			"X-Goog-Upload-Command": "upload, finalize",
			"X-Goog-Upload-Offset": "0",
			"Content-Length": "12",
		});
		expect(putCall?.[1]?.body).toBe(sourceBody);
		expect((putCall?.[1] as { duplex?: string } | undefined)?.duplex).toBe(
			"half",
		);
	});
});

describe("waitForGeminiFile", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("polls until the file is ACTIVE", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					name: "files/abc123",
					uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
					state: "PROCESSING",
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					name: "files/abc123",
					uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
					state: "ACTIVE",
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const sleep = vi.fn(async () => {});

		const file = await waitForGeminiFile("files/abc123", {
			intervalMs: 5,
			sleep,
		});

		expect(file).toEqual({
			name: "files/abc123",
			uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
		});
		expect(sleep).toHaveBeenCalledWith(5);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://generativelanguage.googleapis.com/v1beta/files/abc123",
		);
	});

	it("throws when processing fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					name: "files/abc123",
					uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
					state: "FAILED",
				}),
			),
		);

		await expect(waitForGeminiFile("files/abc123")).rejects.toThrow(
			"failed processing",
		);
	});
});

describe("describeVideoWithGemini", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("parses JSON output and clamps chapter timestamps", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					candidates: [
						{
							content: {
								parts: [
									{
										text: JSON.stringify({
											title: '"Screen walkthrough"',
											summary: "The user opens a dashboard and edits a form.",
											chapters: [
												{ start: -4, title: "Start" },
												{ start: 12, title: "Edit form" },
												{ start: 99, title: "After the end" },
											],
											actionItems: ["Ship the change"],
										}),
									},
								],
							},
						},
					],
				}),
			),
		);

		const result = await describeVideoWithGemini({
			fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
			durationSeconds: 30,
			language: "en",
		});

		expect(result.title).toBe("Screen walkthrough");
		expect(result.title.length).toBeLessThanOrEqual(80);
		expect(result.chapters).toEqual([
			{ start: 0, title: "Start" },
			{ start: 12, title: "Edit form" },
			{ start: 30, title: "After the end" },
		]);
		expect(result.actionItems).toEqual(["Ship the change"]);
	});

	it("retries 429 responses with backoff", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("slow down", { status: 429 }))
			.mockResolvedValueOnce(
				jsonResponse({
					candidates: [
						{
							content: {
								parts: [
									{
										text: JSON.stringify({
											title: "Retry worked",
											summary: "The model answered after a rate limit.",
											chapters: [{ start: 0, title: "Intro" }],
										}),
									},
								],
							},
						},
					],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await describeVideoWithGemini({
			fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
			durationSeconds: 10,
			language: "en",
		});

		expect(result.title).toBe("Retry worked");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("parseGeminiVideoDescription and clampGeminiChapters", () => {
	it("rejects missing required fields and clamps starts into range", () => {
		expect(() =>
			parseGeminiVideoDescription(
				JSON.stringify({ title: "", summary: "ok", chapters: [] }),
				20,
			),
		).toThrow();
		expect(
			clampGeminiChapters(
				[
					{ start: -1, title: "A" },
					{ start: 8, title: "B" },
					{ start: 8, title: "Duplicate" },
					{ start: 40, title: "C" },
				],
				20,
			),
		).toEqual([
			{ start: 0, title: "A" },
			{ start: 8, title: "B" },
			{ start: 20, title: "C" },
		]);
	});
});
