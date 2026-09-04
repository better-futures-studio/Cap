"use client";

import type { MeetingRecapMode } from "@cap/database/schema";
import {
	Button,
	Card,
	CardHeader,
	CardTitle,
	Input,
	Select,
	Switch,
} from "@cap/ui";
import { classNames } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	addMeetingVocabulary,
	disconnectCalendarAction,
	removeMeetingVocabulary,
	setCalendarAutoRecordAction,
	setMeetingPreferences,
} from "@/actions/meetings";
import type {
	CalendarSettings,
	SlackHuddleStatus,
	VocabularyTerm,
} from "./meetings-shared";

function CalendarCard({
	orgId,
	settings,
}: {
	orgId: Organisation.OrganisationId;
	settings: CalendarSettings;
}) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const autoRecordId = useId();

	if (!settings.calendarConfigured) return null;

	if (!settings.calendar) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Calendar</CardTitle>
				</CardHeader>
				<div className="mt-3 flex items-center justify-between gap-3 text-sm">
					<p className="text-gray-10">
						Connect Google Calendar to record meetings automatically
					</p>
					<Button href="/api/integrations/recall-calendar/connect" size="sm">
						Connect
					</Button>
				</div>
			</Card>
		);
	}

	const { calendar } = settings;

	const setAutoRecord = (autoRecord: boolean) => {
		startTransition(async () => {
			try {
				await setCalendarAutoRecordAction({
					orgId,
					calendarRowId: calendar.id,
					autoRecord,
				});
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to update auto-record",
				);
			}
		});
	};

	const disconnect = () => {
		if (
			!window.confirm(
				"Disconnect this Google Calendar? Scheduled recordings for its events will be cancelled.",
			)
		) {
			return;
		}
		startTransition(async () => {
			try {
				await disconnectCalendarAction({ orgId, calendarRowId: calendar.id });
				toast.success("Calendar disconnected");
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to disconnect",
				);
			}
		});
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Calendar</CardTitle>
			</CardHeader>
			<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
				<span className="inline-flex items-center gap-1.5 text-gray-12">
					<span
						className={classNames(
							"h-1.5 w-1.5 rounded-full",
							calendar.status === "connected" ? "bg-green-500" : "bg-gray-8",
						)}
					/>
					Google Calendar · {calendar.platformEmail ?? "connected"}
				</span>
				<label
					htmlFor={autoRecordId}
					className="flex items-center gap-2 text-xs text-gray-10"
				>
					<Switch
						id={autoRecordId}
						checked={calendar.autoRecord}
						disabled={isPending}
						onCheckedChange={setAutoRecord}
					/>
					Auto-record every meeting with a video link
				</label>
				<button
					type="button"
					className="ml-auto text-xs text-gray-10 hover:underline disabled:opacity-50"
					disabled={isPending}
					onClick={disconnect}
				>
					Disconnect
				</button>
			</div>
		</Card>
	);
}

const RECAP_MODE_OPTIONS: { value: MeetingRecapMode; label: string }[] = [
	{ value: "off", label: "Off" },
	{ value: "self", label: "Just me" },
	{ value: "attendees", label: "Me + attendees" },
];

function RecapCard({
	orgId,
	initialRecapMode,
}: {
	orgId: Organisation.OrganisationId;
	initialRecapMode: MeetingRecapMode;
}) {
	const [recapMode, setRecapMode] = useState(initialRecapMode);
	const [isPending, startTransition] = useTransition();

	const save = (mode: MeetingRecapMode) => {
		const previous = recapMode;
		setRecapMode(mode);
		startTransition(async () => {
			try {
				await setMeetingPreferences({ orgId, recapMode: mode });
				toast.success("Recap preference saved");
			} catch (error) {
				setRecapMode(previous);
				toast.error(
					error instanceof Error ? error.message : "Failed to save preference",
				);
			}
		});
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Recap email</CardTitle>
			</CardHeader>
			<div className="mt-3 flex flex-col gap-1">
				<Select
					size="sm"
					value={recapMode}
					onValueChange={(value) => save(value as MeetingRecapMode)}
					disabled={isPending}
					options={RECAP_MODE_OPTIONS}
					placeholder="Recap email"
					className="w-48"
				/>
				<p className="text-xs text-gray-10">
					Sent after the summary is ready. "Me + attendees" emails everyone on
					the calendar invite.
				</p>
			</div>
		</Card>
	);
}

function SlackCard({ status }: { status: SlackHuddleStatus }) {
	if (!status) return null;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Slack</CardTitle>
			</CardHeader>
			<div className="mt-3 flex items-center gap-3 text-sm">
				<span className="inline-flex items-center gap-1.5 text-gray-12">
					<span
						className={classNames(
							"h-1.5 w-1.5 rounded-full",
							status.status === "active" ? "bg-green-500" : "bg-gray-8",
						)}
					/>
					Slack Huddles · {status.status}
				</span>
			</div>
		</Card>
	);
}

function VocabularyCard({
	orgId,
	initialTerms,
}: {
	orgId: Organisation.OrganisationId;
	initialTerms: VocabularyTerm[];
}) {
	const router = useRouter();
	const termId = useId();
	const spellingId = useId();
	const [terms, setTerms] = useState(initialTerms);
	const [term, setTerm] = useState("");
	const [spelling, setSpelling] = useState("");
	const [isPending, startTransition] = useTransition();

	useEffect(() => {
		setTerms(initialTerms);
	}, [initialTerms]);

	const handleAdd = () => {
		if (!term.trim()) {
			toast.error("Enter a term");
			return;
		}
		startTransition(async () => {
			try {
				const row = await addMeetingVocabulary({
					orgId,
					term: term.trim(),
					spelling: spelling.trim() || undefined,
				});
				setTerms((prev) => [
					...prev.filter((existing) => existing.id !== row.id),
					row,
				]);
				setTerm("");
				setSpelling("");
				toast.success("Term added");
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to add term",
				);
			}
		});
	};

	const handleRemove = (id: string) => {
		startTransition(async () => {
			try {
				await removeMeetingVocabulary({ orgId, id });
				setTerms((prev) => prev.filter((existing) => existing.id !== id));
				toast.success("Term removed");
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to remove term",
				);
			}
		});
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Transcription vocabulary</CardTitle>
			</CardHeader>
			<div className="mt-3 flex flex-col gap-3">
				<p className="text-xs text-gray-10">
					Names, products, and terms the transcript should get right. Optional
					preferred spelling.
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<Input
						id={termId}
						placeholder="Term"
						value={term}
						onChange={(event) => setTerm(event.target.value)}
						className="w-40"
					/>
					<Input
						id={spellingId}
						placeholder="Preferred spelling (optional)"
						value={spelling}
						onChange={(event) => setSpelling(event.target.value)}
						className="w-48"
					/>
					<Button size="sm" onClick={handleAdd} disabled={isPending}>
						Add
					</Button>
				</div>
				{terms.length > 0 && (
					<div className="flex flex-wrap gap-2">
						{terms.map((row) => (
							<span
								key={row.id}
								className="inline-flex items-center gap-1.5 rounded-full border border-gray-3 px-2.5 py-1 text-xs text-gray-12"
							>
								{row.term}
								{row.spelling && (
									<span className="text-gray-10">→ {row.spelling}</span>
								)}
								<button
									type="button"
									onClick={() => handleRemove(row.id)}
									disabled={isPending}
									className="text-gray-10 hover:text-gray-12"
									aria-label={`Remove ${row.term}`}
								>
									×
								</button>
							</span>
						))}
					</div>
				)}
			</div>
		</Card>
	);
}

export function SettingsTab({
	orgId,
	calendarSettings,
	slackHuddleStatus,
	initialRecapMode,
	initialVocabulary,
}: {
	orgId: Organisation.OrganisationId;
	calendarSettings: CalendarSettings;
	slackHuddleStatus: SlackHuddleStatus;
	initialRecapMode: MeetingRecapMode;
	initialVocabulary: VocabularyTerm[];
}) {
	return (
		<div className="flex flex-col gap-4">
			<CalendarCard orgId={orgId} settings={calendarSettings} />
			<RecapCard orgId={orgId} initialRecapMode={initialRecapMode} />
			<VocabularyCard orgId={orgId} initialTerms={initialVocabulary} />
			<SlackCard status={slackHuddleStatus} />
		</div>
	);
}
