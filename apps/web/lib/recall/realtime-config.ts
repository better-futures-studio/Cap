import type { RecordingConfig, RecordingRetention } from "./client";
import type { RecallConfig } from "./config";

export function buildLiveRecordingConfig(
	config: RecallConfig,
): RecordingConfig | undefined {
	if (!config.liveAgent) return undefined;
	const transcript: RecordingConfig["transcript"] =
		config.transcriptionProvider === "assemblyai"
			? {
					provider: {
						assembly_ai_v3_streaming: {
							speech_model: "universal-streaming-multilingual",
							language_detection: true,
							format_turns: true,
						},
					},
					diarization: { use_separate_streams_when_available: true },
				}
			: {
					provider: {
						recallai_streaming: {
							mode: "prioritize_low_latency",
							language_code: "en",
						},
					},
					diarization: { use_separate_streams_when_available: true },
				};
	return {
		video_mixed_mp4: {},
		participant_events: {},
		meeting_metadata: {},
		video_mixed_layout: "speaker_view",
		start_recording_on: "participant_join",
		transcript,
		realtime_endpoints: [
			{
				type: "webhook",
				url: `${config.publicBaseUrl.replace(/\/$/, "")}/api/webhooks/recall/realtime`,
				events: ["transcript.data", "participant_events.chat_message"],
			},
		],
	};
}

export function recordingRetention(
	config?: Pick<RecallConfig, "mediaRetentionHours"> | null,
): RecordingRetention {
	return {
		type: "timed",
		hours: config?.mediaRetentionHours ?? 168,
	};
}

export function withRecordingRetention(
	config: Pick<RecallConfig, "mediaRetentionHours"> | null | undefined,
	recording?: RecordingConfig,
): RecordingConfig {
	return {
		...(recording ?? {}),
		retention: recording?.retention ?? recordingRetention(config),
	};
}
