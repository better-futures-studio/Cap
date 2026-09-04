import { db } from "@cap/database";
import { isAllowedFromDomain, sendEmail } from "@cap/database/emails/config";
import { MeetingRecap } from "@cap/database/emails/meeting-recap";
import {
	type MeetingRecapMode,
	meetingBots,
	meetingPreferences,
	organizations,
	users,
	videos,
} from "@cap/database/schema";
import type { MeetingActionItem, VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { ImageUploads } from "@cap/web-backend";
import type { ImageUpload, User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";
import { parseMeetingActionItems } from "./action-items";
import type {
	RecallCalendarEvent,
	RecallClient,
	RecallParticipantEvent,
} from "./client";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./config";
import { getDefaultRecallClient } from "./default-client";
import { formatTalkTimeLine, parseMeetingSpeakerStats } from "./speaker-stats";
import { shareMeetingRecordingWithAttendees } from "./visibility";

export type { MeetingRecapMode };

export const RECAP_FROM_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const RECAP_LOGO_URL_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

export function parseRecapFromAddress(value: string): string | null {
	const address = value.trim().toLowerCase();
	if (!RECAP_FROM_ADDRESS_PATTERN.test(address)) return null;
	return address;
}

export function recapAllowedFromDomain(
	env: { RESEND_FROM_DOMAIN?: string } = serverEnv(),
): string {
	return env.RESEND_FROM_DOMAIN?.trim() ?? "";
}

export function defaultRecapFromAddress(allowedDomain: string): string {
	return `no-reply@${allowedDomain}`;
}

export function resolveRecapSender({
	settings,
	botName,
	allowedDomain,
}: {
	settings?: {
		recapFromName?: string;
		recapFromAddress?: string;
	} | null;
	botName: string;
	allowedDomain: string;
}): { from: string; name: string; address: string } {
	const name = settings?.recapFromName?.trim() || botName;
	const defaultAddress = defaultRecapFromAddress(allowedDomain);
	const overrideAddress = settings?.recapFromAddress?.trim();
	let address = defaultAddress;
	if (overrideAddress) {
		if (allowedDomain && isAllowedFromDomain(overrideAddress, allowedDomain)) {
			address = overrideAddress;
		} else {
			const domain = overrideAddress.split("@")[1] ?? "";
			if (domain) {
				console.warn("[recall] recap from address domain is not allowed", {
					domain,
				});
			}
		}
	}
	return { from: `${name} <${address}>`, name, address };
}

async function resolveOrganizationLogoUrl(
	iconUrl: string,
): Promise<string | null> {
	if (/^https?:\/\//i.test(iconUrl)) return iconUrl;
	try {
		return await Effect.gen(function* () {
			const imageUploads = yield* ImageUploads;
			return yield* imageUploads.resolveImageUrl(
				iconUrl as ImageUpload.ImageUrlOrKey,
				{ expiresIn: RECAP_LOGO_URL_EXPIRES_SECONDS },
			);
		}).pipe(runPromise);
	} catch {
		return null;
	}
}

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
	deps: {
		client?: RecallClient;
		resolveLogoUrl?: (iconUrl: string) => Promise<string | null>;
	} = {},
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

	const [org] = await db()
		.select({
			name: organizations.name,
			iconUrl: organizations.iconUrl,
			settings: organizations.settings,
		})
		.from(organizations)
		.where(eq(organizations.id, row.orgId))
		.limit(1);

	const client = deps.client ?? getDefaultRecallClient();
	const botName = getRecallConfig()?.botName ?? DEFAULT_BOT_NAME;
	const organizationName = org?.name?.trim() || "";
	const sender = resolveRecapSender({
		settings: org?.settings,
		botName,
		allowedDomain: recapAllowedFromDomain(),
	});
	const logoUrl = org?.iconUrl
		? await (deps.resolveLogoUrl ?? resolveOrganizationLogoUrl)(org.iconUrl)
		: null;
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
	const talkTime = formatTalkTimeLine(
		parseMeetingSpeakerStats(metadata.meetingSpeakerStats),
	);
	await shareMeetingRecordingWithAttendees(meetingBotId, { client });

	try {
		for (const email of recipients) {
			await sendEmail({
				email,
				subject: `Recap: ${title}`,
				fromOverride: sender.from,
				react: MeetingRecap({
					email,
					url,
					title,
					date,
					duration,
					summary: metadata.summary ?? "",
					talkTime,
					actionItems,
					recapMode: mode,
					botName,
					organizationName,
					logoUrl,
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
