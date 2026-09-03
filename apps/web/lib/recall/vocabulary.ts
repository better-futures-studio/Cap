import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { meetingVocabulary } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, asc, eq } from "drizzle-orm";

export type MeetingVocabularyRow = {
	id: string;
	orgId: Organisation.OrganisationId;
	term: string;
	spelling: string | null;
	createdAt: Date;
};

export type RecallTranscriptVocabulary = {
	keyTerms: string[];
	spelling: { find: string[]; replace: string }[];
};

function normalizeTerm(value: string): string {
	return value.trim();
}

function normalizeSpelling(value: string | null | undefined): string | null {
	const spelling = value?.trim();
	return spelling ? spelling : null;
}

export function toRecallTranscriptVocabulary(
	rows: Pick<MeetingVocabularyRow, "term" | "spelling">[],
): RecallTranscriptVocabulary {
	const keyTerms: string[] = [];
	const spelling: { find: string[]; replace: string }[] = [];
	const seenTerms = new Set<string>();

	for (const row of rows) {
		const term = normalizeTerm(row.term);
		if (!term || seenTerms.has(term.toLowerCase())) continue;
		seenTerms.add(term.toLowerCase());
		keyTerms.push(term);
		const canonical = normalizeSpelling(row.spelling);
		if (canonical) {
			spelling.push({ find: [term], replace: canonical });
		}
	}

	return { keyTerms, spelling };
}

export async function listMeetingVocabularyTerms(
	orgId: Organisation.OrganisationId,
): Promise<MeetingVocabularyRow[]> {
	return db()
		.select({
			id: meetingVocabulary.id,
			orgId: meetingVocabulary.orgId,
			term: meetingVocabulary.term,
			spelling: meetingVocabulary.spelling,
			createdAt: meetingVocabulary.createdAt,
		})
		.from(meetingVocabulary)
		.where(eq(meetingVocabulary.orgId, orgId))
		.orderBy(asc(meetingVocabulary.term), asc(meetingVocabulary.id));
}

export async function addMeetingVocabularyTerm({
	orgId,
	term,
	spelling,
}: {
	orgId: Organisation.OrganisationId;
	term: string;
	spelling?: string | null;
}): Promise<MeetingVocabularyRow> {
	const normalizedTerm = normalizeTerm(term);
	if (!normalizedTerm) throw new Error("Term is required");
	if (normalizedTerm.length > 255) throw new Error("Term is too long");
	const canonical = normalizeSpelling(spelling);
	if (canonical && canonical.length > 255) {
		throw new Error("Spelling is too long");
	}

	const [existing] = await db()
		.select({
			id: meetingVocabulary.id,
			orgId: meetingVocabulary.orgId,
			term: meetingVocabulary.term,
			spelling: meetingVocabulary.spelling,
			createdAt: meetingVocabulary.createdAt,
		})
		.from(meetingVocabulary)
		.where(
			and(
				eq(meetingVocabulary.orgId, orgId),
				eq(meetingVocabulary.term, normalizedTerm),
			),
		)
		.limit(1);

	if (existing) {
		if (existing.spelling === canonical) return existing;
		await db()
			.update(meetingVocabulary)
			.set({ spelling: canonical })
			.where(eq(meetingVocabulary.id, existing.id));
		return { ...existing, spelling: canonical };
	}

	const row: MeetingVocabularyRow = {
		id: nanoId(),
		orgId,
		term: normalizedTerm,
		spelling: canonical,
		createdAt: new Date(),
	};
	await db().insert(meetingVocabulary).values(row);
	return row;
}

export async function removeMeetingVocabularyTerm({
	orgId,
	id,
}: {
	orgId: Organisation.OrganisationId;
	id: string;
}): Promise<void> {
	await db()
		.delete(meetingVocabulary)
		.where(
			and(eq(meetingVocabulary.id, id), eq(meetingVocabulary.orgId, orgId)),
		);
}
