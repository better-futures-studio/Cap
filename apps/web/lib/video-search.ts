import { db } from "@cap/database";
import {
	meetingBots,
	users,
	videoSearch,
	videoShares,
	videos,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { getDefaultRecallClient } from "@/lib/recall/default-client";
import {
	hydrateCalendarAttendees,
	storedStringArray,
} from "@/lib/recall/visibility";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";
import { vttToPlainText } from "./mcp-transcript";

export async function upsertVideoSearchRow(videoId: string): Promise<void> {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	if (!video) return;

	const metadata = (video.metadata ?? {}) as VideoMetadata;
	const [bot] = await db()
		.select({
			id: meetingBots.id,
			title: meetingBots.title,
			calendarEventId: meetingBots.calendarEventId,
			attendeeEmails: meetingBots.attendeeEmails,
			attendeeNames: meetingBots.attendeeNames,
		})
		.from(meetingBots)
		.where(eq(meetingBots.videoId, video.id))
		.limit(1);

	const sharePeople = await db()
		.select({ email: users.email, name: users.name })
		.from(videoShares)
		.innerJoin(users, eq(users.id, videoShares.userId))
		.where(eq(videoShares.videoId, video.id))
		.limit(200);

	const speakers = (metadata.meetingSpeakerStats?.speakers ?? []).map(
		(speaker) => speaker.name,
	);
	let calendarEmails = storedStringArray(bot?.attendeeEmails) ?? [];
	let calendarNames = storedStringArray(bot?.attendeeNames) ?? [];
	if (bot && bot.attendeeEmails == null && bot.calendarEventId) {
		const hydrated = await hydrateCalendarAttendees({
			meetingBotId: bot.id,
			calendarEventId: bot.calendarEventId,
			client: getDefaultRecallClient(),
		});
		calendarEmails = hydrated?.attendeeEmails ?? [];
		calendarNames = hydrated?.attendeeNames ?? [];
	}
	const participants = [
		...new Set(
			[
				...speakers,
				...sharePeople.flatMap((row) => [row.name, row.email]),
				...calendarEmails,
				...calendarNames,
				bot?.title,
			].filter((value): value is string => Boolean(value?.trim())),
		),
	].join(" ");

	let transcriptText: string | null = null;
	try {
		const vtt = await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
			);
			return yield* bucket.getObject(
				`${video.ownerId}/${video.id}/transcription.vtt`,
			);
		}).pipe(runPromise);
		if (Option.isSome(vtt) && vtt.value.trim()) {
			transcriptText = vttToPlainText(vtt.value);
		}
	} catch {
		transcriptText = null;
	}

	await db()
		.insert(videoSearch)
		.values({
			videoId: video.id,
			orgId: video.orgId,
			ownerId: video.ownerId,
			title: bot?.title?.trim() || video.name,
			summary: metadata.summary ?? null,
			transcriptText,
			participants: participants || null,
		})
		.onDuplicateKeyUpdate({
			set: {
				orgId: video.orgId,
				ownerId: video.ownerId,
				title: bot?.title?.trim() || video.name,
				summary: metadata.summary ?? null,
				transcriptText,
				participants: participants || null,
			},
		});
}
