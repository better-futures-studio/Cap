import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { MeetingRecap } from "@cap/database/emails/meeting-recap";
import {
	type MeetingRecapMode,
	meetingBots,
	meetingPreferences,
	users,
	videos,
} from "@cap/database/schema";
import type { MeetingActionItem, VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { parseMeetingActionItems } from "./action-items";
import type {
	RecallCalendarEvent,
	RecallClient,
	RecallParticipantEvent,
} from "./client";
import { getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";

export type { MeetingRecapMode };

const LEGACY_AI_SUMMARY_FALLBACK =
	"The AI was unable to generate a proper summary for this content.";
const MAX_RECIPIENTS = 25;
const RESOURCE_EMAIL = /@resource\.calendar\.google\.com$/i;

function getAffectedRows(result: unknown): number {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

export function parseRecapMode(value: unknown): MeetingRecapMode {
	if (value === "off" || value === "self" || value === "attendees")
		return value;
	return "self";
}

export function isRecapReady(video: {
	transcriptionStatus: string | null;
	metadata: VideoMetadata | null;
}): boolean {
	const summary = video.metadata?.summary?.trim();
	return (
		video.transcriptionStatus === "COMPLETE" &&
		!!summary &&
		summary !== LEGACY_AI_SUMMARY_FALLBACK
	);
}

export function isResourceAttendee(attendee: {
	email?: string;
	resource?: boolean;
	displayName?: string;
}): boolean {
	if (attendee.resource) return true;
	const email = attendee.email?.trim() ?? "";
	if (RESOURCE_EMAIL.test(email)) return true;
	const label = `${attendee.displayName ?? ""} ${email}`.toLowerCase();
	return /\b(conference room|meeting room)\b/.test(label);
}

export function resolveRecapRecipients({
	mode,
	ownerEmail,
	attendeeEmails,
}: {
	mode: MeetingRecapMode;
	ownerEmail: string | null;
	attendeeEmails: string[];
}): string[] {
	if (mode === "off") return [];
	const owner = ownerEmail?.trim().toLowerCase() ?? "";
	if (mode === "self") return owner ? [owner] : [];

	const emails: string[] = [];
	const seen = new Set<string>();
	const push = (value: string) => {
		const email = value.trim().toLowerCase();
		if (!email || !email.includes("@") || seen.has(email)) return;
		if (emails.length >= MAX_RECIPIENTS) return;
		seen.add(email);
		emails.push(email);
	};
	if (owner) push(owner);
	for (const email of attendeeEmails) push(email);
	return emails;
}

function calendarAttendeeEmails(
	event: RecallCalendarEvent,
	botName: string,
): string[] {
	const raw = event.raw;
	if (!raw || typeof raw !== "object" || !("attendees" in raw)) return [];
	const attendees = (raw as { attendees?: unknown }).attendees;
	if (!Array.isArray(attendees)) return [];
	const bot = botName.trim().toLowerCase();
	return attendees.flatMap((attendee) => {
		if (!attendee || typeof attendee !== "object") return [];
		const row = attendee as {
			email?: string;
			resource?: boolean;
			displayName?: string;
		};
		if (isResourceAttendee(row)) return [];
		const email = row.email?.trim() ?? "";
		if (!email) return [];
		const display = (row.displayName ?? "").trim().toLowerCase();
		if (bot && (display === bot || email.toLowerCase().includes(bot))) {
			return [];
		}
		return [email];
	});
}

function participantEmails(
	events: RecallParticipantEvent[],
	botName: string,
): string[] {
	const bot = botName.trim().toLowerCase();
	const emails: string[] = [];
	const seen = new Set<string>();
	for (const event of events) {
		const email = event.participant.email?.trim();
		if (!email) continue;
		const name = (event.participant.name ?? "").trim().toLowerCase();
		if (bot && name === bot) continue;
		const key = email.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		emails.push(email);
	}
	return emails;
}

function formatDuration(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return `${minutes} min`;
	return `${total}s`;
}

function formatDate(value: Date): string {
	return value.toLocaleDateString(undefined, {
		weekday: "long",
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

async function loadAttendeeEmails({
	row,
	client,
	botName,
}: {
	row: typeof meetingBots.$inferSelect;
	client: RecallClient;
	botName: string;
}): Promise<string[]> {
	if (row.calendarEventId) {
		try {
			const event = await client.getCalendarEvent(row.calendarEventId);
			return calendarAttendeeEmails(event, botName);
		} catch {
			return [];
		}
	}
	if (!row.recallRecordingId) return [];
	try {
		const recording = await client.getRecording(row.recallRecordingId);
		const downloadUrl =
			recording.media_shortcuts.participant_events?.data
				?.participant_events_download_url;
		if (!downloadUrl) return [];
		const events =
			await client.downloadJson<RecallParticipantEvent[]>(downloadUrl);
		return participantEmails(Array.isArray(events) ? events : [], botName);
	} catch {
		return [];
	}
}

export async function sendMeetingRecap(
	meetingBotId: string,
	deps: { client?: RecallClient } = {},
): Promise<{ sent: boolean; recipients: number }> {
	const [row] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.id, meetingBotId))
		.limit(1);
	if (!row?.videoId) return { sent: false, recipients: 0 };

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, row.videoId))
		.limit(1);
	if (!video) return { sent: false, recipients: 0 };

	const metadata = (video.metadata as VideoMetadata) || {};
	if (
		!isRecapReady({ transcriptionStatus: video.transcriptionStatus, metadata })
	) {
		return { sent: false, recipients: 0 };
	}

	const [owner] = await db()
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, row.ownerId))
		.limit(1);

	const [preference] = await db()
		.select({ recapMode: meetingPreferences.recapMode })
		.from(meetingPreferences)
		.where(eq(meetingPreferences.userId, row.ownerId as User.UserId))
		.limit(1);
	const mode = parseRecapMode(preference?.recapMode);

	const client = deps.client ?? getDefaultRecallClient();
	const botName = getRecallConfig()?.botName ?? "Boca Pro Notetaker";
	const attendeeEmails =
		mode === "attendees"
			? await loadAttendeeEmails({ row, client, botName })
			: [];
	const recipients = resolveRecapRecipients({
		mode,
		ownerEmail: owner?.email ?? null,
		attendeeEmails,
	});
	if (recipients.length === 0) return { sent: false, recipients: 0 };

	const claimed = await db()
		.update(meetingBots)
		.set({ recapSentAt: new Date() })
		.where(
			and(eq(meetingBots.id, meetingBotId), isNull(meetingBots.recapSentAt)),
		);
	if (getAffectedRows(claimed) === 0) {
		return { sent: false, recipients: 0 };
	}

	const title = row.title?.trim() || video.name || "Meeting";
	const url = `${serverEnv().WEB_URL.replace(/\/$/, "")}/s/${row.videoId}`;
	const date = formatDate(row.joinAt ?? video.createdAt);
	const duration = formatDuration(video.duration);
	const actionItems: MeetingActionItem[] = parseMeetingActionItems(
		metadata.meetingActionItems,
	);

	try {
		for (const email of recipients) {
			await sendEmail({
				email,
				subject: `Recap: ${title}`,
				react: MeetingRecap({
					email,
					url,
					title,
					date,
					duration,
					summary: metadata.summary ?? "",
					actionItems,
					recapMode: mode,
				}),
			});
		}
		console.info("[recall] sent meeting recap", {
			meetingBotId,
			recipients: recipients.length,
		});
		return { sent: true, recipients: recipients.length };
	} catch (error) {
		await db()
			.update(meetingBots)
			.set({ recapSentAt: null })
			.where(eq(meetingBots.id, meetingBotId));
		throw error;
	}
}
