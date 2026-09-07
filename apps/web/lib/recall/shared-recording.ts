import { db } from "@cap/database";
import { meetingBots } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export function sharedMeetingSubCode(meetingBotId: string): string {
	return `shared:${meetingBotId}`;
}

export function hasStartedRecordingImport(row: {
	recallRecordingId: string | null;
	videoId: string | null;
}): boolean {
	return row.recallRecordingId !== null || row.videoId !== null;
}

export function isActiveRecordingImport(row: {
	recallRecordingId: string | null;
	videoId: string | null;
	status: string;
}): boolean {
	return row.status !== "failed" && hasStartedRecordingImport(row);
}

export function findActiveImportSibling<
	T extends {
		id: string;
		recallRecordingId: string | null;
		videoId: string | null;
		status: string;
	},
>(rowId: string, siblings: T[]): T | undefined {
	return siblings.find(
		(sibling) => sibling.id !== rowId && isActiveRecordingImport(sibling),
	);
}

export function findActiveImportForRecording<
	T extends {
		id: string;
		recallRecordingId: string | null;
		status: string;
	},
>(rowId: string, recordingId: string, siblings: T[]): T | undefined {
	return siblings.find(
		(sibling) =>
			sibling.id !== rowId &&
			sibling.recallRecordingId === recordingId &&
			sibling.status !== "failed",
	);
}

export async function markMeetingBotShared(
	rowId: string,
	primaryId: string,
): Promise<void> {
	await db()
		.update(meetingBots)
		.set({ statusSubCode: sharedMeetingSubCode(primaryId) })
		.where(eq(meetingBots.id, rowId));
}

export async function claimMeetingBotImport({
	meetingBotId,
	recordingId,
}: {
	meetingBotId: string;
	recordingId: string;
}): Promise<boolean> {
	const [row] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);
	if (!row) {
		throw new Error("Meeting bot not found");
	}
	if (row.recallRecordingId || row.videoId || row.status === "complete") {
		return false;
	}

	if (row.recallBotId) {
		const siblings = await db()
			.select()
			.from(meetingBots)
			.where(eq(meetingBots.recallBotId, row.recallBotId));
		const owner = findActiveImportForRecording(
			meetingBotId,
			recordingId,
			siblings,
		);
		if (owner) {
			await markMeetingBotShared(meetingBotId, owner.id);
			return false;
		}
	}

	await db()
		.update(meetingBots)
		.set({
			status: "importing",
			statusSubCode: null,
			recallRecordingId: recordingId,
			errorMessage: null,
		})
		.where(eq(meetingBots.id, meetingBotId));
	return true;
}
