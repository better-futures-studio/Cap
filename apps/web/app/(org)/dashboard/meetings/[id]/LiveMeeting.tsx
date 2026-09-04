"use client";

import type { MeetingBotStatus } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { askLiveMeeting } from "@/actions/meeting-live";
import { MarkdownAnswer } from "@/components/MarkdownAnswer";
import type { LiveUtterance } from "@/lib/recall/live-transcript";

const ACTIVE = new Set<MeetingBotStatus>([
	"in_call_not_recording",
	"in_call_recording",
]);

export function LiveMeeting({
	orgId,
	meetingBotId,
	title,
	status,
	utterances,
}: {
	orgId: Organisation.OrganisationId;
	meetingBotId: string;
	title: string;
	status: MeetingBotStatus;
	utterances: LiveUtterance[];
}) {
	const router = useRouter();
	const [question, setQuestion] = useState("");
	const [answer, setAnswer] = useState("");
	const [pending, startTransition] = useTransition();
	const questionId = useId();
	useEffect(() => {
		if (!ACTIVE.has(status)) return;
		const interval = window.setInterval(() => router.refresh(), 5000);
		return () => window.clearInterval(interval);
	}, [router, status]);
	return (
		<main className="mx-auto max-w-3xl space-y-6 p-6">
			<header>
				<h1 className="text-xl font-semibold">{title}</h1>
				<span className="inline-flex rounded-full bg-blue-500/10 px-2 py-1 text-xs text-blue-700">
					{status.replaceAll("_", " ")}
				</span>
			</header>
			<section className="space-y-2 rounded-lg border border-gray-5 p-4">
				<h2 className="font-medium">Live transcript</h2>
				{utterances.length ? (
					utterances.map((utterance, index) => (
						<p key={`${utterance.t}-${index}`} className="text-sm text-gray-11">
							<strong>{utterance.speaker}:</strong> {utterance.text}
						</p>
					))
				) : (
					<p className="text-sm text-gray-10">
						Waiting for the meeting transcript.
					</p>
				)}
			</section>
			<form
				className="space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (!question.trim()) return;
					startTransition(async () => {
						setAnswer(await askLiveMeeting({ orgId, meetingBotId, question }));
					});
				}}
			>
				<label className="text-sm font-medium" htmlFor={questionId}>
					Ask about this meeting
				</label>
				<div className="flex gap-2">
					<input
						id={questionId}
						value={question}
						onChange={(event) => setQuestion(event.target.value)}
						className="min-w-0 flex-1 rounded border border-gray-6 px-3 py-2"
					/>
					<button
						type="submit"
						disabled={pending}
						className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
					>
						Ask
					</button>
				</div>
				{answer && <MarkdownAnswer content={answer} />}
			</form>
		</main>
	);
}
