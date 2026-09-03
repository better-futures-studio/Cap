"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { meetingBots } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import { answerLiveMeeting } from "@/lib/recall/chat-agent";

export async function askLiveMeeting({
	orgId,
	meetingBotId,
	question,
}: {
	orgId: Organisation.OrganisationId;
	meetingBotId: string;
	question: string;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	await requireOrganizationAccess(user.id, orgId);
	const [meeting] = await db()
		.select({ id: meetingBots.id })
		.from(meetingBots)
		.where(and(eq(meetingBots.id, meetingBotId), eq(meetingBots.orgId, orgId)))
		.limit(1);
	if (!meeting) throw new Error("Meeting not found");
	return answerLiveMeeting({ meetingBotId: meeting.id, question });
}
