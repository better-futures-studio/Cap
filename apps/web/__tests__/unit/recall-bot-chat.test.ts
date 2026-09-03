import { describe, expect, it } from "vitest";
import { buildJoinChatMessage } from "@/lib/recall/bot-chat";

const config = {
	botName: "Boca Pro Notetaker",
	agentTrigger: "/nt",
};

describe("buildJoinChatMessage", () => {
	it("returns a recording notice when the live agent is off", () => {
		expect(buildJoinChatMessage({ ...config, liveAgent: false })).toBe(
			"Boca Pro Notetaker is recording this meeting.",
		);
	});

	it("includes trigger examples when the live agent is on", () => {
		const message = buildJoinChatMessage({ ...config, liveAgent: true });
		expect(message).toBe(
			[
				"Boca Pro Notetaker is recording this meeting.",
				"Ask me anything with /nt — e.g. /nt summarize, /nt action items, /nt catch me up, or /nt what's the weather in Tampa?",
				"Save a note to the recording with /nt note: … or /nt action item: …",
			].join("\n"),
		);
		expect(message.length).toBeLessThan(400);
	});
});
