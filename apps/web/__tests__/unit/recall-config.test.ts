import { describe, expect, it } from "vitest";
import {
	botImageUrlForOrg,
	DEFAULT_BOT_NAME,
	getRecallConfig,
} from "@/lib/recall/config";

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

	it("defaults the bot name and per-org card image URL", () => {
		const config = getRecallConfig(env());
		expect(config).not.toBeNull();
		if (!config) return;
		expect(config.botName).toBe(DEFAULT_BOT_NAME);
		expect(config.botName).toBe("Meeting Notetaker");
		expect(config.botImageUrl).toBe("https://cap.test/api/meeting-bot/card");
		expect(botImageUrlForOrg(config, "org_1")).toBe(
			"https://cap.test/api/meeting-bot/card?orgId=org_1",
		);
	});

	it("keeps RECALL_BOT_IMAGE_URL as an override", () => {
		const config = getRecallConfig(
			env({ RECALL_BOT_IMAGE_URL: "https://cdn.example.com/bot.jpg" }),
		);
		expect(config).not.toBeNull();
		if (!config) return;
		expect(config.botImageUrl).toBe("https://cdn.example.com/bot.jpg");
		expect(botImageUrlForOrg(config, "org_1")).toBe(
			"https://cdn.example.com/bot.jpg",
		);
	});
});
