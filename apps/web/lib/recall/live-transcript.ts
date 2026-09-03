import { db } from "@cap/database";
import { meetingBots } from "@cap/database/schema";
import { Storage } from "@cap/web-backend/src/Storage/index";
import type { Organisation, User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

export type LiveUtterance = { t: number; speaker: string; text: string };
export type LiveCapture = { t: number; speaker: string; text: string };
export type LiveTranscript = {
	version: 1;
	updatedAt: string;
	utterances: LiveUtterance[];
	captures: LiveCapture[];
};

type LiveTranscriptDeps = {
	read?: (meetingBotId: string) => Promise<LiveTranscript | null>;
	write?: (meetingBotId: string, document: LiveTranscript) => Promise<void>;
};

const locks = new Map<string, Promise<void>>();

function emptyTranscript(): LiveTranscript {
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		utterances: [],
		captures: [],
	};
}

function key(meetingBotId: string) {
	return `meeting-bots/${meetingBotId}/live-transcript.json`;
}

async function storageFor(meetingBotId: string) {
	const [row] = await db()
		.select({ orgId: meetingBots.orgId, ownerId: meetingBots.ownerId })
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);
	if (!row) throw new Error("Meeting bot not found");
	const writable = await Storage.getWritableAccessForUser(
		row.ownerId as User.UserId,
		row.orgId as Organisation.OrganisationId,
	).pipe(runWorkflowPromise);
	return writable.access;
}

async function readStored(
	meetingBotId: string,
): Promise<LiveTranscript | null> {
	const object = await (await storageFor(meetingBotId))
		.getObject(key(meetingBotId))
		.pipe(runWorkflowPromise);
	if (Option.isNone(object)) return null;
	try {
		const value: unknown = JSON.parse(object.value);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return null;
		const document = value as Partial<LiveTranscript>;
		return {
			version: 1,
			updatedAt:
				typeof document.updatedAt === "string"
					? document.updatedAt
					: new Date().toISOString(),
			utterances: Array.isArray(document.utterances)
				? document.utterances.filter(isUtterance)
				: [],
			captures: Array.isArray(document.captures)
				? document.captures.filter(isUtterance)
				: [],
		};
	} catch {
		return null;
	}
}

function isUtterance(value: unknown): value is LiveUtterance {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Partial<LiveUtterance>;
	return (
		Number.isFinite(entry.t) &&
		typeof entry.speaker === "string" &&
		typeof entry.text === "string"
	);
}

async function writeStored(meetingBotId: string, document: LiveTranscript) {
	await (await storageFor(meetingBotId))
		.putObject(key(meetingBotId), JSON.stringify(document), {
			contentType: "application/json",
		})
		.pipe(runWorkflowPromise);
}

async function update(
	meetingBotId: string,
	change: (document: LiveTranscript) => void,
	deps: LiveTranscriptDeps,
) {
	const previous = locks.get(meetingBotId) ?? Promise.resolve();
	let release: () => void = () => undefined;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => next);
	locks.set(meetingBotId, queued);
	await previous;
	try {
		const document =
			(await (deps.read ?? readStored)(meetingBotId)) ?? emptyTranscript();
		change(document);
		document.updatedAt = new Date().toISOString();
		await (deps.write ?? writeStored)(meetingBotId, document);
	} finally {
		release();
		if (locks.get(meetingBotId) === queued) locks.delete(meetingBotId);
	}
}

export async function appendUtterance(
	meetingBotId: string,
	utterance: LiveUtterance,
	deps: LiveTranscriptDeps = {},
) {
	// ponytail: process-local mutex; replace with a distributed lock when calls span concurrent instances.
	await update(
		meetingBotId,
		(document) => document.utterances.push(utterance),
		deps,
	);
}

export async function appendCapture(
	meetingBotId: string,
	capture: LiveCapture,
	deps: LiveTranscriptDeps = {},
) {
	await update(
		meetingBotId,
		(document) => document.captures.push(capture),
		deps,
	);
}

export async function readLiveTranscript(
	meetingBotId: string,
	deps: LiveTranscriptDeps = {},
) {
	return (deps.read ?? readStored)(meetingBotId);
}

export function liveTranscriptAsText(
	document: LiveTranscript | null,
	maxChars: number,
) {
	const text = (document?.utterances ?? [])
		.map((utterance) => `${utterance.speaker}: ${utterance.text}`)
		.join("\n");
	return text.length > maxChars ? text.slice(-maxChars) : text;
}
