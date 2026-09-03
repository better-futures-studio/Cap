import { db } from "@cap/database";
import { comments, videos } from "@cap/database/schema";
import type { MeetingActionItem, VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

export type { MeetingActionItem };

const MAX_ACTION_ITEMS = 15;

function normalizeActionItemText(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseMeetingActionItems(value: unknown): MeetingActionItem[] {
	if (!Array.isArray(value)) return [];
	const items: MeetingActionItem[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const text = typeof record.text === "string" ? record.text.trim() : "";
		if (!text) continue;
		items.push({
			text,
			owner:
				typeof record.owner === "string" && record.owner.trim()
					? record.owner.trim()
					: null,
			due:
				typeof record.due === "string" && record.due.trim()
					? record.due.trim()
					: null,
		});
		if (items.length >= MAX_ACTION_ITEMS) break;
	}
	return items;
}

export function parseCapturedActionItem(
	content: string,
): MeetingActionItem | null {
	const match = content.trim().match(/^Action item:\s*(.*)$/i);
	const rest = match?.[1]?.trim();
	if (!rest) return null;
	const ownerSplit = rest.match(/^([^:]{1,80}):\s+(.+)$/);
	if (ownerSplit?.[1] && ownerSplit[2]) {
		return {
			text: ownerSplit[2].trim(),
			owner: ownerSplit[1].trim(),
			due: null,
		};
	}
	return { text: rest, owner: null, due: null };
}

export function mergeMeetingActionItems(
	aiItems: MeetingActionItem[],
	commentContents: { content: string }[],
): MeetingActionItem[] {
	const merged: MeetingActionItem[] = [];
	const seen = new Set<string>();

	const push = (item: MeetingActionItem) => {
		const key = normalizeActionItemText(item.text);
		if (!key || seen.has(key) || merged.length >= MAX_ACTION_ITEMS) return;
		seen.add(key);
		merged.push({
			text: item.text.trim(),
			owner: item.owner?.trim() || null,
			due: item.due?.trim() || null,
		});
	};

	for (const row of commentContents) {
		const captured = parseCapturedActionItem(row.content);
		if (captured) push(captured);
	}
	for (const item of aiItems) {
		if (item.text.trim()) push(item);
	}

	return merged;
}

export async function getMeetingActionItems(
	videoId: string,
): Promise<MeetingActionItem[]> {
	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	return parseMeetingActionItems(
		(video?.metadata as VideoMetadata | undefined)?.meetingActionItems,
	);
}

export async function loadCapturedActionItemComments(
	videoId: string,
): Promise<{ content: string }[]> {
	return db()
		.select({ content: comments.content })
		.from(comments)
		.where(eq(comments.videoId, videoId as Video.VideoId));
}
