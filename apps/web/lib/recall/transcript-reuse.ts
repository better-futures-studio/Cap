import type { RecallRecording } from "./client";

export function reusableRecordingTranscript(
	recording: RecallRecording,
): { id: string; status: "done" | "processing" } | null {
	const transcript = recording.media_shortcuts.transcript;
	if (!transcript?.id) return null;
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
