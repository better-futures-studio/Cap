import type { RecordingConfig } from "./client";
import type { RecallConfig } from "./config";

export function buildLiveRecordingConfig(
	config: RecallConfig,
): RecordingConfig | undefined {
	if (!config.liveAgent) return undefined;
	return {
		video_mixed_mp4: {},
		participant_events: {},
		meeting_metadata: {},
		video_mixed_layout: "speaker_view",
		start_recording_on: "participant_join",
		transcript: {
			provider: {
				recallai_streaming: {
					mode: "prioritize_low_latency",
					language_code: "en",
				},
			},
			diarization: { use_separate_streams_when_available: true },
		},
		realtime_endpoints: [
			{
				type: "webhook",
				url: `${config.publicBaseUrl.replace(/\/$/, "")}/api/webhooks/recall/realtime/`,
				events: ["transcript.data", "participant_events.chat_message"],
			},
		],
	};
}
