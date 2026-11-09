"use client";

import { Button, Input } from "@cap/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
	type FormEvent,
	useEffect,
	useId,
	useRef,
	useState,
	useTransition,
} from "react";
import {
	readRecordingFilters,
	recordingDateBounds,
	recordingDateInput,
} from "@/lib/recordings/filters";

export function RecordingFilters({
	placeholder = "Search by Cap title or meeting name/link",
}: {
	placeholder?: string;
}) {
	const params = useSearchParams();
	const filters = readRecordingFilters(Object.fromEntries(params));
	return (
		<RecordingFilterForm
			key={`${filters.q}:${filters.from}:${filters.to}:${filters.sort}`}
			placeholder={placeholder}
		/>
	);
}

function RecordingFilterForm({ placeholder }: { placeholder: string }) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const filters = readRecordingFilters(Object.fromEntries(searchParams));
	const id = useId();
	const formRef = useRef<HTMLFormElement>(null);
	const [fromDate, setFromDate] = useState("");
	const [toDate, setToDate] = useState("");
	const [error, setError] = useState("");
	const [pending, startTransition] = useTransition();

	useEffect(() => {
		setFromDate(recordingDateInput(filters.from));
		setToDate(recordingDateInput(filters.to, true));
	}, [filters.from, filters.to]);

	const navigate = (params: URLSearchParams) => {
		params.delete("page");
		const query = params.toString();
		startTransition(() => {
			router.push(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
		});
	};

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		try {
			const bounds = recordingDateBounds(fromDate, toDate);
			const params = new URLSearchParams(searchParams);
			const values = {
				q: String(form.get("q") ?? "").trim(),
				...bounds,
				sort: form.get("sort") === "oldest" ? "oldest" : "",
			};
			for (const [key, value] of Object.entries(values)) {
				if (value) params.set(key, value);
				else params.delete(key);
			}
			setError("");
			navigate(params);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Invalid date range");
		}
	};

	return (
		<form
			ref={formRef}
			onSubmit={submit}
			className="mb-6 flex flex-col gap-3"
			aria-label="Filter recordings"
			aria-busy={pending}
		>
			<fieldset disabled={pending} className="flex flex-wrap items-end gap-3">
				<label
					htmlFor={`${id}-q`}
					className="flex min-w-56 flex-1 flex-col gap-1 text-xs text-gray-11"
				>
					Search recordings
					<Input
						id={`${id}-q`}
						type="search"
						name="q"
						maxLength={255}
						defaultValue={filters.q}
						placeholder={placeholder}
					/>
				</label>
				<label
					htmlFor={`${id}-from`}
					className="flex flex-col gap-1 text-xs text-gray-11"
				>
					From
					<Input
						id={`${id}-from`}
						type="date"
						value={fromDate}
						max={toDate || undefined}
						onChange={(event) => setFromDate(event.target.value)}
					/>
				</label>
				<label
					htmlFor={`${id}-to`}
					className="flex flex-col gap-1 text-xs text-gray-11"
				>
					To (inclusive)
					<Input
						id={`${id}-to`}
						type="date"
						value={toDate}
						min={fromDate || undefined}
						onChange={(event) => setToDate(event.target.value)}
					/>
				</label>
				<label
					htmlFor={`${id}-sort`}
					className="flex flex-col gap-1 text-xs text-gray-11"
				>
					Sort by date
					<select
						id={`${id}-sort`}
						name="sort"
						defaultValue={filters.sort}
						className="h-11 rounded-xl border border-gray-4 bg-gray-1 px-3 text-sm text-gray-12"
					>
						<option value="newest">Newest first</option>
						<option value="oldest">Oldest first</option>
					</select>
				</label>
				<Button type="submit" spinner={pending} className="h-11">
					Apply
				</Button>
				<Button
					type="button"
					variant="gray"
					className="h-11"
					onClick={() => {
						formRef.current?.reset();
						setFromDate("");
						setToDate("");
						setError("");
						const params = new URLSearchParams(searchParams);
						for (const key of ["q", "from", "to", "sort"]) params.delete(key);
						navigate(params);
					}}
				>
					Clear filters
				</Button>
			</fieldset>
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
		</form>
	);
}
