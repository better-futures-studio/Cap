import { meetingBots, videos } from "@cap/database/schema";
import {
	and,
	eq,
	exists,
	gte,
	lt,
	or,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import type { RecordingFilters } from "./filters";

function containsText(column: SQLWrapper, query: string) {
	const pattern = `%${query.toLowerCase().replace(/[!%_]/g, "!$&")}%`;
	return sql`LOWER(${column}) LIKE ${pattern} ESCAPE '!'`;
}

export function capRecordingConditions(filters: RecordingFilters) {
	return and(
		filters.q
			? or(
					containsText(videos.name, filters.q),
					exists(
						sql`(SELECT 1 FROM ${meetingBots} WHERE ${and(
							eq(meetingBots.videoId, videos.id),
							eq(meetingBots.orgId, videos.orgId),
							or(
								containsText(meetingBots.title, filters.q),
								containsText(meetingBots.meetingUrl, filters.q),
							),
						)})`,
					),
				)
			: undefined,
		filters.from
			? gte(videos.effectiveCreatedAt, new Date(filters.from))
			: undefined,
		filters.to
			? lt(videos.effectiveCreatedAt, new Date(filters.to))
			: undefined,
	);
}

export function meetingRecordingConditions(filters: RecordingFilters) {
	return and(
		filters.q
			? or(
					containsText(meetingBots.title, filters.q),
					containsText(meetingBots.meetingUrl, filters.q),
				)
			: undefined,
		filters.from ? gte(meetingBots.joinAt, new Date(filters.from)) : undefined,
		filters.to ? lt(meetingBots.joinAt, new Date(filters.to)) : undefined,
	);
}
