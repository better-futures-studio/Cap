import type { MeetingActionItem } from "@cap/database/types";

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
