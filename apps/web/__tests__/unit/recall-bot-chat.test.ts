import { describe, expect, it } from "vitest";
import { buildJoinChatMessage } from "@/lib/recall/bot-chat";

const config = {
	botName: "Meeting Notetaker",
	agentTrigger: "/nt",
};

describe("buildJoinChatMessage", () => {
	it("returns a recording notice when the live agent is off", () => {
		expect(buildJoinChatMessage({ ...config, liveAgent: false })).toBe(
			"Meeting Notetaker is recording this meeting.",
		);
	});

	it("includes trigger examples when the live agent is on", () => {
		const message = buildJoinChatMessage({ ...config, liveAgent: true });
		expect(message.split("\n\n")).toEqual([
			"Meeting Notetaker is recording this meeting.",
			"Ask me anything with /nt, for example:\n/nt summarize\n/nt action items\n/nt catch me up\n/nt what's the weather in Tampa?",
			"Save a note to the recording:\n/nt note: …\n/nt action item: …",
		]);
		expect(message.length).toBeLessThan(400);
	});
});
