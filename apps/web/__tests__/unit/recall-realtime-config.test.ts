import { describe, expect, it } from "vitest";
import type { RecallConfig } from "@/lib/recall/config";
import { buildLiveRecordingConfig } from "@/lib/recall/realtime-config";

const config: RecallConfig = {
	apiKey: "key",
	region: "us-west-2",
	baseUrl: "https://us-west-2.recall.ai",
	verificationSecret: null,
	botName: "Meeting Notetaker",
	publicBaseUrl: "https://cap.test/",
	botImageUrl: "https://cap.test/bot.jpg",
	liveAgent: true,
	agentTrigger: "/nt",
	transcriptionProvider: "recallai",
	calendarGoogle: null,
	mediaRetentionHours: 168,
	deleteMediaAfterImport: true,
};

describe("buildLiveRecordingConfig", () => {
	it("includes the Recall recording defaults and trailing-slash endpoint", () => {
		const recording = buildLiveRecordingConfig(config);
		expect(recording).toMatchObject({
			video_mixed_layout: "speaker_view",
			start_recording_on: "participant_join",
			video_mixed_mp4: {},
			participant_events: {},
			meeting_metadata: {},
			realtime_endpoints: [
				{
					type: "webhook",
					url: "https://cap.test/api/webhooks/recall/realtime",
					events: ["transcript.data", "participant_events.chat_message"],
				},
			],
			transcript: {
				provider: {
					recallai_streaming: {
						mode: "prioritize_low_latency",
						language_code: "en",
					},
				},
				diarization: { use_separate_streams_when_available: true },
			},
		});
	});

	it("is disabled unless live agent is enabled", () => {
		expect(
			buildLiveRecordingConfig({ ...config, liveAgent: false }),
		).toBeUndefined();
	});

	it("uses AssemblyAI streaming when the transcription provider is assemblyai", () => {
		expect(
			buildLiveRecordingConfig({
				...config,
				transcriptionProvider: "assemblyai",
			})?.transcript?.provider,
		).toEqual({
			assembly_ai_v3_streaming: {
				speech_model: "universal-streaming-multilingual",
				language_detection: true,
				format_turns: true,
			},
		});
	});
});
