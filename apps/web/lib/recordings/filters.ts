export type RecordingFilters = {
	q: string;
	from?: string;
	to?: string;
	sort: "newest" | "oldest";
};

type SearchValues = Record<string, string | string[] | null | undefined>;

function readInstant(value: SearchValues[string]): string | undefined {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
	)
		return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) && date.toISOString() === value
		? value
		: undefined;
}

export function readRecordingFilters(values: SearchValues): RecordingFilters {
	return {
		q: typeof values.q === "string" ? values.q.trim().slice(0, 255) : "",
		from: readInstant(values.from),
		to: readInstant(values.to),
		sort: values.sort === "oldest" ? "oldest" : "newest",
	};
}

export function hasRecordingFilters(filters: RecordingFilters): boolean {
	return Boolean(filters.q || filters.from || filters.to);
}

export function readRecordingPage(value: unknown): number {
	const page = typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function recordingDateInput(instant?: string, end = false): string {
	if (!instant) return "";
	const date = new Date(new Date(instant).getTime() - (end ? 1 : 0));
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function recordingDateBounds(from: string, to: string) {
	const start = from ? new Date(`${from}T00:00:00`) : undefined;
	const end = to ? new Date(`${to}T00:00:00`) : undefined;
	if (
		(start && !Number.isFinite(start.getTime())) ||
		(end && !Number.isFinite(end.getTime())) ||
		(start && end && start > end)
	) {
		throw new Error("Choose a valid date range, with From on or before To.");
	}
	if (end) end.setDate(end.getDate() + 1);
	return { from: start?.toISOString(), to: end?.toISOString() };
}

export function recordingPageHref(
	pathname: string,
	search: string,
	page: number,
): string {
	const params = new URLSearchParams(search);
	params.set("page", String(page));
	return `${pathname}?${params}`;
}
