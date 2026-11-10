export type RecordingLibraryFilters = {
	search: string;
	mode: string;
	from: string;
	to: string;
	sort: "newest" | "oldest";
};

type LibraryRecording = {
	prettyName: string;
	path: string;
	meta: { mode: string; sort_time_millis: number };
};

export function filterLibraryRecordings<T extends LibraryRecording>(
	recordings: readonly T[],
	filters: RecordingLibraryFilters,
): T[] {
	const query = filters.search.trim().toLowerCase();
	const from = filters.from ? new Date(`${filters.from}T00:00:00`) : undefined;
	const to = filters.to ? new Date(`${filters.to}T00:00:00`) : undefined;
	if (to) to.setDate(to.getDate() + 1);
	return recordings
		.filter((recording) => {
			const timestamp = recording.meta.sort_time_millis;
			return (
				(filters.mode === "all" || recording.meta.mode === filters.mode) &&
				recording.prettyName.toLowerCase().includes(query) &&
				(!from || timestamp >= from.getTime()) &&
				(!to || timestamp < to.getTime())
			);
		})
		.sort((a, b) => {
			const aTime = a.meta.sort_time_millis;
			const bTime = b.meta.sort_time_millis;
			if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : 0;
			if (!Number.isFinite(bTime)) return -1;
			const difference = aTime - bTime;
			return (
				(filters.sort === "oldest" ? difference : -difference) ||
				a.path.localeCompare(b.path)
			);
		});
}

export function recordingCalendarDate(timestamp: number): string {
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return "Date unavailable";
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
