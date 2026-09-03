import { db } from "@cap/database";
import { meetingCalendars } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import {
	applyCalendarEventDecisions,
	type MeetingCalendarRow,
} from "@/lib/recall/calendars";
import type { RecallCalendarEvent } from "@/lib/recall/client";
import { getDefaultRecallClient } from "@/lib/recall/default-client";

async function loadCalendarRow(
	recallCalendarId: string,
): Promise<MeetingCalendarRow | null> {
	"use step";

	const [row] = await db()
		.select()
		.from(meetingCalendars)
		.where(eq(meetingCalendars.recallCalendarId, recallCalendarId))
		.limit(1);
	return row ?? null;
}

async function fetchUpdatedEvents(
	recallCalendarId: string,
	updatedAtGte: string | undefined,
): Promise<RecallCalendarEvent[]> {
	"use step";

	const client = getDefaultRecallClient();
	return client.listCalendarEvents({
		calendarId: recallCalendarId,
		updatedAtGte,
	});
}

async function applyEvents(
	calendar: MeetingCalendarRow,
	events: RecallCalendarEvent[],
): Promise<void> {
	"use step";

	await applyCalendarEventDecisions({
		calendar: {
			id: calendar.id,
			orgId: calendar.orgId,
			userId: calendar.userId,
			autoRecord: calendar.autoRecord,
		},
		events,
		now: new Date(),
	});
}

async function markCalendarSynced(calendarRowId: string): Promise<void> {
	"use step";

	await db()
		.update(meetingCalendars)
		.set({ lastSyncedAt: new Date(), status: "connected" })
		.where(eq(meetingCalendars.id, calendarRowId));
}

export async function syncCalendarEventsWorkflow({
	recallCalendarId,
	updatedAtGte,
}: {
	recallCalendarId: string;
	updatedAtGte?: string;
}): Promise<void> {
	"use workflow";

	const calendar = await loadCalendarRow(recallCalendarId);
	if (!calendar) return;

	const events = await fetchUpdatedEvents(recallCalendarId, updatedAtGte);
	await applyEvents(calendar, events);
	await markCalendarSynced(calendar.id);
}
