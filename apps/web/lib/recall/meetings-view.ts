const PLATFORM_HOSTS: [RegExp, string][] = [
	[/zoom\.us$/, "Zoom"],
	[/meet\.google\.com$/, "Google Meet"],
	[/teams\.microsoft\.com$/, "Microsoft Teams"],
	[/teams\.live\.com$/, "Microsoft Teams"],
	[/webex\.com$/, "Webex"],
];

export function meetingPlatformLabel(url: string, source?: string): string {
	if (!url && source === "slack") return "Slack Huddle";

	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return "Meeting";
	}
	for (const [pattern, label] of PLATFORM_HOSTS) {
		if (pattern.test(hostname)) return label;
	}
	return "Meeting";
}

export function meetingUrlLabel(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.pathname && parsed.pathname !== "/"
			? `${parsed.hostname}${parsed.pathname}`
			: parsed.hostname;
	} catch {
		return url;
	}
}

function dayKey(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function groupByDay<T>(
	items: T[],
	now: Date,
	getTime: (item: T) => Date,
): { label: string; items: T[] }[] {
	const sorted = [...items].sort(
		(a, b) => getTime(a).getTime() - getTime(b).getTime(),
	);

	const todayKey = dayKey(now);
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	const tomorrowKey = dayKey(tomorrow);

	const groups: { label: string; items: T[] }[] = [];
	for (const item of sorted) {
		const time = getTime(item);
		const key = dayKey(time);
		const label =
			key === todayKey
				? "Today"
				: key === tomorrowKey
					? "Tomorrow"
					: time.toLocaleDateString(undefined, {
							weekday: "short",
							month: "short",
							day: "numeric",
						});
		const last = groups.at(-1);
		if (last && last.label === label) {
			last.items.push(item);
		} else {
			groups.push({ label, items: [item] });
		}
	}
	return groups;
}
