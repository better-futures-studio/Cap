import { describe, expect, it } from "vitest";
import { getRecallConfig } from "@/lib/recall/config";

type RecallEnv = NonNullable<Parameters<typeof getRecallConfig>[0]>;

function env(overrides: Partial<RecallEnv> = {}): RecallEnv {
	return {
		RECALL_API_KEY: "key",
		WEB_URL: "https://cap.test",
		RECALL_LIVE_AGENT: false,
		...overrides,
	} as RecallEnv;
}

describe("getRecallConfig", () => {
	it("defaults transcriptionProvider to recallai", () => {
		expect(getRecallConfig(env())?.transcriptionProvider).toBe("recallai");
	});

	it("uses assemblyai when RECALL_TRANSCRIPTION_PROVIDER is set", () => {
		expect(
			getRecallConfig(env({ RECALL_TRANSCRIPTION_PROVIDER: "assemblyai" }))
				?.transcriptionProvider,
		).toBe("assemblyai");
	});
});
