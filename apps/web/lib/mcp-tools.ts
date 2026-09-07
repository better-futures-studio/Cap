import { db } from "@cap/database";
import {
	comments,
	meetingBots,
	users,
	videoShares,
	videos,
} from "@cap/database/schema";
import type {
	MeetingActionItem,
	MeetingSpeakerStats,
	VideoMetadata,
} from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDefaultRecallClient } from "@/lib/recall/default-client";
import {
	dedupeUpcomingMeetings,
	meetingPlatformLabel,
} from "@/lib/recall/meetings-view";
import { parseMeetingActionItems } from "@/lib/recall/parse-action-items";
import {
	hydrateCalendarAttendees,
	meetingBotIdsAccessibleToUser,
	storedStringArray,
} from "@/lib/recall/visibility";
import { listAccessibleVideoIds, loadViewableVideo } from "./mcp-access";
import { askRecordingForUser, loadTranscriptVtt } from "./mcp-ask";
import type { McpPrincipal } from "./mcp-auth";
import {
	capTranscriptText,
	formatTranscriptText,
	formatTranscriptVtt,
	parseVttCuesWithSpeakers,
	trimTranscriptCues,
} from "./mcp-transcript";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export type MeetingSearchHit = {
	id: string;
	title: string;
	startedAt: string;
	durationSeconds: number | null;
	platform: string;
	attendees: string[];
	summary: string | null;
	url: string;
};

export function clampLimit(limit?: number) {
	if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function webUrl() {
	return serverEnv().WEB_URL.replace(/\/$/, "");
}

export function recordingShareUrl(videoId: string) {
	return `${webUrl()}/s/${videoId}`;
}

function metadataOf(value: unknown): VideoMetadata {
	return value && typeof value === "object" ? (value as VideoMetadata) : {};
}

function summaryPreview(summary: string | undefined) {
	if (!summary) return null;
	const trimmed = summary.trim();
	if (!trimmed) return null;
	return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

function attendeesFromMetadata(metadata: VideoMetadata) {
	const speakers = metadata.meetingSpeakerStats?.speakers ?? [];
	return speakers.map((speaker) => speaker.name).filter(Boolean);
}

function matchesLike(
	haystacks: Array<string | null | undefined>,
	query: string,
) {
	const needle = query.toLowerCase();
	return haystacks.some((value) => value?.toLowerCase().includes(needle));
}

function parseIsoDate(value?: string) {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

async function attendeesForVideo(
	videoId: Video.VideoId,
	metadata: VideoMetadata,
	bot: {
		id: string;
		calendarEventId: string | null;
		attendeeEmails: string[] | null;
		attendeeNames: string[] | null;
	} | null,
) {
	const names = new Set(attendeesFromMetadata(metadata));
	const shares = await db()
		.select({ email: users.email, name: users.name })
		.from(videoShares)
		.innerJoin(users, eq(users.id, videoShares.userId))
		.where(eq(videoShares.videoId, videoId))
		.limit(200);
	for (const row of shares) {
		if (row.name?.trim()) names.add(row.name.trim());
		if (row.email?.trim()) names.add(row.email.trim());
	}
	let emails = storedStringArray(bot?.attendeeEmails);
	let storedNames = storedStringArray(bot?.attendeeNames);
	if (emails == null && bot?.calendarEventId) {
		const hydrated = await hydrateCalendarAttendees({
			meetingBotId: bot.id,
			calendarEventId: bot.calendarEventId,
			client: getDefaultRecallClient(),
		});
		emails = hydrated?.attendeeEmails ?? null;
		storedNames = hydrated?.attendeeNames ?? storedNames;
	}
	for (const name of storedNames ?? []) {
		if (name.trim()) names.add(name.trim());
	}
	for (const email of emails ?? []) {
		if (email.trim()) names.add(email.trim());
	}
	return [...names];
}

async function loadSearchRows(accessibleIds: string[]) {
	if (accessibleIds.length === 0) return [];
	return db()
		.select({
			id: videos.id,
			name: videos.name,
			createdAt: videos.createdAt,
			duration: videos.duration,
			metadata: videos.metadata,
			meetingTitle: meetingBots.title,
			meetingUrl: meetingBots.meetingUrl,
			joinAt: meetingBots.joinAt,
			source: meetingBots.source,
			calendarEventId: meetingBots.calendarEventId,
			attendeeEmails: meetingBots.attendeeEmails,
			attendeeNames: meetingBots.attendeeNames,
		})
		.from(videos)
		.leftJoin(meetingBots, eq(meetingBots.videoId, videos.id))
		.where(inArray(videos.id, accessibleIds as Video.VideoId[]))
		.orderBy(desc(videos.createdAt))
		.limit(400);
}

function toSearchHit(
	row: Awaited<ReturnType<typeof loadSearchRows>>[number],
	attendees: string[],
): MeetingSearchHit {
	const metadata = metadataOf(row.metadata);
	return {
		id: row.id,
		title: row.meetingTitle?.trim() || row.name,
		startedAt: (row.joinAt ?? row.createdAt).toISOString(),
		durationSeconds: row.duration ?? null,
		platform: meetingPlatformLabel(
			row.meetingUrl ?? "",
			row.source ?? undefined,
		),
		attendees,
		summary: summaryPreview(metadata.summary),
		url: recordingShareUrl(row.id),
	};
}

type SearchCandidate = Awaited<ReturnType<typeof loadSearchRows>>[number] & {
	attendees: string[];
};

export function applyMeetingSearchFilters(
	rows: SearchCandidate[],
	accessible: Set<string>,
	input: {
		query?: string;
		from?: string;
		to?: string;
		attendee?: string;
		limit?: number;
		meetingsOnly?: boolean;
	},
): MeetingSearchHit[] {
	const from = parseIsoDate(input.from);
	const to = parseIsoDate(input.to);
	const query = input.query?.trim();
	const attendee = input.attendee?.trim();
	const limit = clampLimit(input.limit);
	const hits: MeetingSearchHit[] = [];

	for (const row of rows) {
		if (!accessible.has(row.id)) continue;
		if (input.meetingsOnly !== false && !row.joinAt && !row.meetingUrl) {
			continue;
		}
		const started = row.joinAt ?? row.createdAt;
		if (from && started < from) continue;
		if (to && started > to) continue;
		const metadata = metadataOf(row.metadata);
		const actionText = (metadata.meetingActionItems ?? [])
			.map((item) => item.text)
			.join(" ");
		const speakerText = (metadata.meetingSpeakerStats?.speakers ?? [])
			.map((speaker) => speaker.name)
			.join(" ");
		if (
			query &&
			!matchesLike(
				[
					row.name,
					row.meetingTitle,
					metadata.summary,
					actionText,
					speakerText,
					row.attendees.join(" "),
				],
				query,
			)
		) {
			continue;
		}
		if (attendee && !matchesLike(row.attendees, attendee)) continue;
		hits.push(toSearchHit(row, row.attendees));
		if (hits.length >= limit) break;
	}
	return hits;
}

export async function searchMeetings(
	principal: McpPrincipal,
	input: {
		query?: string;
		from?: string;
		to?: string;
		attendee?: string;
		limit?: number;
		meetingsOnly?: boolean;
	},
): Promise<MeetingSearchHit[]> {
	const accessible = await listAccessibleVideoIds(principal);
	const rows = await loadSearchRows([...accessible]);
	const candidates: SearchCandidate[] = [];
	for (const row of rows) {
		if (!accessible.has(row.id)) continue;
		candidates.push({
			...row,
			attendees: [
				...attendeesFromMetadata(metadataOf(row.metadata)),
				...(storedStringArray(row.attendeeNames) ?? []),
				...(storedStringArray(row.attendeeEmails) ?? []),
				...(await shareEmails(row.id)),
			],
		});
	}
	return applyMeetingSearchFilters(candidates, accessible, input);
}

async function shareEmails(videoId: string) {
	const rows = await db()
		.select({ email: users.email, name: users.name })
		.from(videoShares)
		.innerJoin(users, eq(users.id, videoShares.userId))
		.where(eq(videoShares.videoId, videoId as Video.VideoId))
		.limit(100);
	return rows.flatMap((row) =>
		[row.name, row.email].filter((value): value is string => Boolean(value)),
	);
}

export async function searchRecordings(
	principal: McpPrincipal,
	input: { query: string; limit?: number },
) {
	return searchMeetings(principal, {
		query: input.query,
		limit: input.limit,
		meetingsOnly: false,
	});
}

export async function getMeeting(principal: McpPrincipal, id: string) {
	const video = await loadViewableVideo(principal, id);
	if (!video) return null;
	const accessible = await listAccessibleVideoIds(principal);
	if (!accessible.has(video.id)) return null;

	const [bot] = await db()
		.select()
		.from(meetingBots)
		.where(eq(meetingBots.videoId, video.id))
		.limit(1);
	const metadata = metadataOf(video.metadata);
	const [commentCount] = await db()
		.select({ count: sql<number>`count(*)` })
		.from(comments)
		.where(eq(comments.videoId, video.id));
	const notetakerComments = await loadNotetakerComments(video.id);
	const attendees = await attendeesForVideo(video.id, metadata, bot ?? null);

	return {
		id: video.id,
		title: bot?.title?.trim() || video.name,
		startedAt: (bot?.joinAt ?? video.createdAt).toISOString(),
		durationSeconds: video.duration ?? null,
		platform: meetingPlatformLabel(bot?.meetingUrl ?? "", bot?.source),
		url: recordingShareUrl(video.id),
		summary: metadata.summary ?? null,
		chapters: metadata.chapters ?? [],
		actionItems: parseMeetingActionItems(metadata.meetingActionItems),
		speakerStats: metadata.meetingSpeakerStats ?? null,
		attendees,
		commentCount: Number(commentCount?.count ?? 0),
		notetakerQa: notetakerComments,
	};
}

async function loadNotetakerComments(videoId: string) {
	return db()
		.select({
			id: comments.id,
			content: comments.content,
			timestamp: comments.timestamp,
			createdAt: comments.createdAt,
			authorName: users.name,
		})
		.from(comments)
		.innerJoin(users, eq(users.id, comments.authorId))
		.where(
			and(
				eq(comments.videoId, videoId as Video.VideoId),
				eq(users.systemKind, "notetaker"),
			),
		)
		.orderBy(comments.createdAt)
		.limit(100);
}

export async function getTranscript(
	principal: McpPrincipal,
	input: {
		id: string;
		startSeconds?: number;
		endSeconds?: number;
		format?: "text" | "vtt";
	},
) {
	const video = await loadViewableVideo(principal, input.id);
	if (!video) return null;
	const accessible = await listAccessibleVideoIds(principal);
	if (!accessible.has(video.id)) return null;
	if (video.transcriptionStatus !== "COMPLETE") {
		return { status: "not_ready" as const };
	}
	const vtt = await loadTranscriptVtt(video, video.id);
	if (!vtt) return { status: "not_ready" as const };
	const cues = trimTranscriptCues(
		parseVttCuesWithSpeakers(vtt),
		input.startSeconds,
		input.endSeconds,
	);
	if (input.format === "vtt") {
		const capped = capTranscriptText(formatTranscriptVtt(cues));
		return {
			status: "available" as const,
			format: "vtt" as const,
			transcript: capped.text,
			truncated: capped.truncated,
		};
	}
	const capped = capTranscriptText(formatTranscriptText(cues));
	return {
		status: "available" as const,
		format: "text" as const,
		transcript: capped.text,
		truncated: capped.truncated,
	};
}

export async function askRecording(
	principal: McpPrincipal,
	input: { id: string; question: string },
) {
	const video = await loadViewableVideo(principal, input.id);
	if (!video) return null;
	const accessible = await listAccessibleVideoIds(principal);
	if (!accessible.has(video.id)) return null;
	const [bot] = await db()
		.select({ id: meetingBots.id })
		.from(meetingBots)
		.where(eq(meetingBots.videoId, video.id))
		.limit(1);
	return askRecordingForUser({
		principal,
		video,
		question: input.question,
		meetingBotId: bot?.id ?? null,
	});
}

export async function listUpcomingMeetings(principal: McpPrincipal, days = 7) {
	const windowDays = Math.min(30, Math.max(1, Math.floor(days)));
	const now = new Date();
	const until = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
	const bots = await db()
		.select({
			id: meetingBots.id,
			ownerId: meetingBots.ownerId,
			recallBotId: meetingBots.recallBotId,
			videoId: meetingBots.videoId,
			calendarEventId: meetingBots.calendarEventId,
			statusSubCode: meetingBots.statusSubCode,
			attendeeEmails: meetingBots.attendeeEmails,
			title: meetingBots.title,
			joinAt: meetingBots.joinAt,
			meetingUrl: meetingBots.meetingUrl,
			source: meetingBots.source,
			status: meetingBots.status,
		})
		.from(meetingBots)
		.where(and(gte(meetingBots.joinAt, now), lte(meetingBots.joinAt, until)))
		.orderBy(meetingBots.joinAt)
		.limit(200);
	const allowed = await meetingBotIdsAccessibleToUser({
		bots,
		userId: principal.id,
	});
	return dedupeUpcomingMeetings(
		bots.filter((bot) => allowed.has(bot.id)),
		principal.id,
	).map((bot) => ({
		id: bot.id,
		title: bot.title,
		joinAt: bot.joinAt.toISOString(),
		platform: meetingPlatformLabel(bot.meetingUrl, bot.source),
		meetingUrl: bot.meetingUrl,
		recordingOn: bot.status !== "opted_out" && bot.status !== "cancelled",
	}));
}

export async function listActionItems(
	principal: McpPrincipal,
	input: { from?: string; to?: string; owner?: string; limit?: number },
) {
	const accessible = await listAccessibleVideoIds(principal);
	if (accessible.size === 0) return [];
	const rows = await db()
		.select({
			id: videos.id,
			name: videos.name,
			createdAt: videos.createdAt,
			metadata: videos.metadata,
			meetingTitle: meetingBots.title,
			joinAt: meetingBots.joinAt,
		})
		.from(videos)
		.leftJoin(meetingBots, eq(meetingBots.videoId, videos.id))
		.where(inArray(videos.id, [...accessible] as Video.VideoId[]))
		.orderBy(desc(videos.createdAt))
		.limit(200);

	const from = parseIsoDate(input.from);
	const to = parseIsoDate(input.to);
	const owner = input.owner?.trim().toLowerCase();
	const limit = clampLimit(input.limit);
	const items: Array<{
		text: string;
		owner: string | null;
		due: string | null;
		meetingId: string;
		meetingTitle: string;
		url: string;
		timestamp: string;
	}> = [];

	for (const row of rows) {
		if (!accessible.has(row.id)) continue;
		const started = row.joinAt ?? row.createdAt;
		if (from && started < from) continue;
		if (to && started > to) continue;
		const actionItems = parseMeetingActionItems(
			metadataOf(row.metadata).meetingActionItems,
		);
		for (const item of actionItems) {
			if (owner && !(item.owner ?? "").toLowerCase().includes(owner)) continue;
			items.push({
				text: item.text,
				owner: item.owner,
				due: item.due,
				meetingId: row.id,
				meetingTitle: row.meetingTitle?.trim() || row.name,
				url: recordingShareUrl(row.id),
				timestamp: started.toISOString(),
			});
			if (items.length >= limit) return items;
		}
	}
	return items;
}

export type { MeetingActionItem, MeetingSpeakerStats };
