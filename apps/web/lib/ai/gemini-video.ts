import { serverEnv } from "@cap/env";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
	getAiGenerationLanguageName,
} from "@cap/web-domain";
import { z } from "zod";

const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";
const DEFAULT_GEMINI_VIDEO_MODEL = "gemini-3.5-flash";
const UPLOAD_START_URL = `${GEMINI_API_ORIGIN}/upload/v1beta/files`;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;
const RETRY_ATTEMPTS = 3;
const MIN_SPEECH_WORD_COUNT = 20;

const geminiChapterSchema = z.object({
	start: z.number().finite(),
	title: z.string().trim().min(1),
});

const geminiVideoDescriptionSchema = z.object({
	title: z.string().trim().min(1),
	summary: z.string().trim().min(1),
	chapters: z.array(geminiChapterSchema).default([]),
	actionItems: z.array(z.string()).optional(),
});

export type GeminiVideoDescription = {
	title: string;
	summary: string;
	chapters: { start: number; title: string }[];
	actionItems?: string[];
};

export type GeminiFileRef = {
	name: string;
	uri: string;
};

type GeminiFetchInit = RequestInit & { duplex?: "half" };

let loggedVideoUnderstandingDisabled = false;

export function isVideoUnderstandingEnabled(): boolean {
	const enabled = Boolean(serverEnv().GOOGLE_GENERATIVE_AI_API_KEY);
	if (!enabled && !loggedVideoUnderstandingDisabled) {
		loggedVideoUnderstandingDisabled = true;
		console.log(
			"[gemini-video] GOOGLE_GENERATIVE_AI_API_KEY is unset; silent-video AI is disabled",
		);
	}
	return enabled;
}

export function getGeminiVideoModel(): string {
	return serverEnv().GEMINI_VIDEO_MODEL || DEFAULT_GEMINI_VIDEO_MODEL;
}

export function getVideoDescriptionLanguageInstruction(
	language: AiGenerationLanguage,
): string {
	if (language === AI_GENERATION_LANGUAGE_AUTO) {
		return "Write the title, summary, chapter titles, and action items in the language of any on-screen text. If none is readable, use English.";
	}

	return `Write the title, summary, chapter titles, and action items in ${getAiGenerationLanguageName(language)}.`;
}

export function transcriptTextFromVtt(vtt: string): string {
	return vtt
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) =>
				line &&
				line !== "WEBVTT" &&
				!line.includes("-->") &&
				!/^\d+$/.test(line),
		)
		.join(" ");
}

export function countTranscriptWords(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return trimmed.split(/\s+/).filter(Boolean).length;
}

export function isTranscriptTooShort(text: string): boolean {
	return countTranscriptWords(text) < MIN_SPEECH_WORD_COUNT;
}

export function clampGeminiChapters(
	chapters: { start: number; title: string }[],
	durationSeconds: number,
): { start: number; title: string }[] {
	const maxStart = Math.max(0, durationSeconds);
	const clamped = chapters
		.map((chapter) => ({
			title: chapter.title.trim(),
			start: Math.min(Math.max(0, chapter.start), maxStart),
		}))
		.filter((chapter) => chapter.title.length > 0)
		.sort((a, b) => a.start - b.start);

	const deduped: { start: number; title: string }[] = [];
	for (const chapter of clamped) {
		const last = deduped[deduped.length - 1];
		if (!last || last.start !== chapter.start) {
			deduped.push(chapter);
		}
	}
	return deduped;
}

export async function uploadVideoToGemini({
	sourceUrl,
	sizeBytes,
	displayName,
}: {
	sourceUrl: string;
	sizeBytes: number;
	displayName: string;
}): Promise<GeminiFileRef> {
	const startedAt = Date.now();
	const uploadUrl = await startResumableUpload(sizeBytes, displayName);
	const file = await putVideoBytes(uploadUrl, sourceUrl, sizeBytes);
	console.log("[gemini-video] uploaded", {
		model: getGeminiVideoModel(),
		bytes: sizeBytes,
		elapsedMs: Date.now() - startedAt,
		file: file.name,
	});
	return file;
}

export async function waitForGeminiFile(
	name: string,
	options: {
		intervalMs?: number;
		timeoutMs?: number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<GeminiFileRef> {
	const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
	const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;
	const sleep = options.sleep ?? sleepMs;
	const deadline = Date.now() + timeoutMs;
	const fileName = normalizeGeminiFileName(name);

	for (;;) {
		const file = await getGeminiFile(fileName);
		if (file.state === "ACTIVE") {
			return { name: file.name, uri: file.uri };
		}
		if (file.state === "FAILED") {
			throw new Error(`Gemini file ${file.name} failed processing`);
		}
		if (Date.now() >= deadline) {
			throw new Error(`Gemini file ${file.name} did not become ACTIVE in time`);
		}
		await sleep(intervalMs);
	}
}

export async function describeVideoWithGemini({
	fileUri,
	durationSeconds,
	language,
}: {
	fileUri: string;
	durationSeconds: number;
	language: AiGenerationLanguage;
}): Promise<GeminiVideoDescription> {
	const startedAt = Date.now();
	const model = getGeminiVideoModel();
	const languageInstruction = getVideoDescriptionLanguageInstruction(language);
	const duration = Math.max(0, durationSeconds);
	const prompt = `This is a screen recording with no narration. Describe what the user does. ${languageInstruction}

The video is ${duration} seconds long. Return JSON with:
- title: a concise title, max 80 characters, no quotation marks
- summary: 2-4 short paragraphs describing what happens on screen
- chapters: 4-10 chapters spanning the recording, each with start (seconds from 0 to ${duration}) and title
- actionItems: optional list of concrete follow-ups visible in the recording

All chapter start values MUST be between 0 and ${duration} seconds.`;

	const response = await geminiFetch(
		`${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": requireGeminiApiKey(),
			},
			body: JSON.stringify({
				contents: [
					{
						parts: [
							{ file_data: { mime_type: "video/mp4", file_uri: fileUri } },
							{ text: prompt },
						],
					},
				],
				generationConfig: {
					responseMimeType: "application/json",
					responseSchema: {
						type: "OBJECT",
						properties: {
							title: { type: "STRING" },
							summary: { type: "STRING" },
							chapters: {
								type: "ARRAY",
								items: {
									type: "OBJECT",
									properties: {
										start: { type: "NUMBER" },
										title: { type: "STRING" },
									},
									required: ["start", "title"],
								},
							},
							actionItems: {
								type: "ARRAY",
								items: { type: "STRING" },
							},
						},
						required: ["title", "summary", "chapters"],
					},
				},
			}),
		},
		"describe video",
	);

	const payload = (await response.json()) as {
		candidates?: { content?: { parts?: { text?: string }[] } }[];
	};
	const text = payload.candidates?.[0]?.content?.parts
		?.map((part) => part.text ?? "")
		.join("")
		.trim();
	if (!text) {
		throw new Error("Gemini video description was empty");
	}

	const description = parseGeminiVideoDescription(text, duration);
	console.log("[gemini-video] described", {
		model,
		elapsedMs: Date.now() - startedAt,
		durationSeconds: duration,
	});
	return description;
}

export async function deleteGeminiFile(name: string): Promise<void> {
	const fileName = normalizeGeminiFileName(name);
	try {
		const response = await geminiFetch(
			`${GEMINI_API_ORIGIN}/v1beta/${fileName}`,
			{
				method: "DELETE",
				headers: { "x-goog-api-key": requireGeminiApiKey() },
			},
			"delete file",
		);
		await response.arrayBuffer();
	} catch (error) {
		console.warn("[gemini-video] failed to delete file", {
			name: fileName,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}

export function parseGeminiVideoDescription(
	content: string,
	durationSeconds: number,
): GeminiVideoDescription {
	const parsed = geminiVideoDescriptionSchema.parse(JSON.parse(content));
	const title = parsed.title.replace(/["“”]/g, "").trim().slice(0, 80);
	if (!title) {
		throw new Error("Gemini video description did not contain a valid title");
	}

	const actionItems = parsed.actionItems
		?.map((item) => item.trim())
		.filter(Boolean);

	return {
		title,
		summary: parsed.summary.trim(),
		chapters: clampGeminiChapters(parsed.chapters, durationSeconds),
		...(actionItems && actionItems.length > 0 ? { actionItems } : {}),
	};
}

function requireGeminiApiKey(): string {
	const key = serverEnv().GOOGLE_GENERATIVE_AI_API_KEY;
	if (!key) {
		throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");
	}
	return key;
}

async function startResumableUpload(
	sizeBytes: number,
	displayName: string,
): Promise<string> {
	const response = await geminiFetch(
		UPLOAD_START_URL,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": requireGeminiApiKey(),
				"X-Goog-Upload-Protocol": "resumable",
				"X-Goog-Upload-Command": "start",
				"X-Goog-Upload-Header-Content-Length": String(sizeBytes),
				"X-Goog-Upload-Header-Content-Type": "video/mp4",
			},
			body: JSON.stringify({ file: { display_name: displayName } }),
		},
		"start resumable upload",
	);

	const uploadUrl = response.headers.get("x-goog-upload-url");
	if (!uploadUrl) {
		throw new Error("Gemini resumable upload did not return x-goog-upload-url");
	}
	await response.arrayBuffer();
	return uploadUrl;
}

async function putVideoBytes(
	uploadUrl: string,
	sourceUrl: string,
	sizeBytes: number,
): Promise<GeminiFileRef> {
	let lastError: unknown;

	for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
		const source = await fetch(sourceUrl);
		if (!source.ok) {
			throw new Error(
				`Failed to read source video: ${source.status} ${source.statusText}`,
			);
		}
		if (!source.body) {
			throw new Error("Source video response did not include a body stream");
		}

		try {
			const response = await fetch(uploadUrl, {
				method: "PUT",
				headers: {
					"Content-Length": String(sizeBytes),
					"X-Goog-Upload-Offset": "0",
					"X-Goog-Upload-Command": "upload, finalize",
					"x-goog-api-key": requireGeminiApiKey(),
				},
				body: source.body,
				duplex: "half",
			} as GeminiFetchInit);

			if (response.ok) {
				const payload = (await response.json()) as unknown;
				return parseGeminiFileRef(payload);
			}

			const body = await response.text();
			lastError = new Error(
				`upload video bytes failed: ${response.status} ${body}`,
			);
			if (
				!shouldRetryStatus(response.status) ||
				attempt === RETRY_ATTEMPTS - 1
			) {
				throw lastError;
			}
		} catch (error) {
			lastError = error;
			if (attempt === RETRY_ATTEMPTS - 1) throw error;
			if (error instanceof Error && !shouldRetryError(error)) throw error;
		}

		await sleepMs(500 * 2 ** attempt);
	}

	throw lastError instanceof Error
		? lastError
		: new Error("upload video bytes failed");
}

async function getGeminiFile(
	name: string,
): Promise<GeminiFileRef & { state: string }> {
	const response = await geminiFetch(
		`${GEMINI_API_ORIGIN}/v1beta/${name}`,
		{
			method: "GET",
			headers: { "x-goog-api-key": requireGeminiApiKey() },
		},
		"get file",
	);
	const payload = (await response.json()) as unknown;
	const file = parseGeminiFile(payload);
	return file;
}

async function geminiFetch(
	url: string,
	init: GeminiFetchInit,
	label: string,
): Promise<Response> {
	let lastError: unknown;

	for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(url, init);
			if (response.ok) return response;
			const body = await response.text();
			lastError = new Error(`${label} failed: ${response.status} ${body}`);
			if (
				!shouldRetryStatus(response.status) ||
				attempt === RETRY_ATTEMPTS - 1
			) {
				throw lastError;
			}
		} catch (error) {
			lastError = error;
			if (attempt === RETRY_ATTEMPTS - 1) throw error;
			if (error instanceof Error && !shouldRetryError(error)) throw error;
		}

		await sleepMs(500 * 2 ** attempt);
	}

	throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

function shouldRetryStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function shouldRetryError(error: Error): boolean {
	const statusMatch = error.message.match(/failed: (\d{3})/);
	if (!statusMatch?.[1]) return true;
	return shouldRetryStatus(Number(statusMatch[1]));
}

function parseGeminiFileRef(payload: unknown): GeminiFileRef {
	const file = parseGeminiFile(payload);
	return { name: file.name, uri: file.uri };
}

function parseGeminiFile(payload: unknown): GeminiFileRef & { state: string } {
	const root =
		payload && typeof payload === "object" && "file" in payload
			? (payload as { file: unknown }).file
			: payload;
	if (!root || typeof root !== "object") {
		throw new Error("Gemini file response was empty");
	}
	const record = root as {
		name?: unknown;
		uri?: unknown;
		state?: unknown;
	};
	if (typeof record.name !== "string" || !record.name) {
		throw new Error("Gemini file response did not include a name");
	}
	const uri =
		typeof record.uri === "string" && record.uri
			? record.uri
			: `${GEMINI_API_ORIGIN}/v1beta/${normalizeGeminiFileName(record.name)}`;
	return {
		name: record.name,
		uri,
		state: typeof record.state === "string" ? record.state : "PROCESSING",
	};
}

function normalizeGeminiFileName(name: string): string {
	return name.startsWith("files/") ? name : `files/${name}`;
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
