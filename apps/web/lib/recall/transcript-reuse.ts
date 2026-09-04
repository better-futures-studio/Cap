import type { RecallRecording } from "./client";

// Streaming models cover fewer languages (no Arabic) than the async ones, so a
// live transcript is only good enough for the in-call agent, never as the
// final transcript.
function isStreamingProvider(
	provider: Record<string, unknown> | null | undefined,
): boolean {
	return Object.keys(provider ?? {}).some((key) => key.includes("streaming"));
}

export function reusableRecordingTranscript(
	recording: RecallRecording,
): { id: string; status: "done" | "processing" } | null {
	const transcript = recording.media_shortcuts.transcript;
	if (!transcript?.id) return null;
	if (isStreamingProvider(transcript.provider)) return null;
	const code = transcript.status?.code;
	if (code === "done" || code === "processing") {
		return { id: transcript.id, status: code };
	}
	return null;
}

export function shouldStartTranscriptCompletion(
	row: { recallTranscriptId: string | null; status: string },
	transcriptId: string,
): boolean {
	return !(
		row.recallTranscriptId === transcriptId &&
		(row.status === "transcribing" || row.status === "complete")
	);
}
