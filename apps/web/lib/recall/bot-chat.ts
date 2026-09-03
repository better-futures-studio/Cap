import type { RecallConfig } from "./config";

export function buildJoinChatMessage(
	config: Pick<RecallConfig, "botName" | "liveAgent" | "agentTrigger">,
): string {
	const recording = `${config.botName} is recording this meeting.`;
	if (!config.liveAgent) return recording;

	const trigger = config.agentTrigger;
	return [
		recording,
		`Ask me anything with ${trigger} — e.g. ${trigger} summarize, ${trigger} action items, ${trigger} catch me up, or ${trigger} what's the weather in Tampa?`,
		`Save a note to the recording with ${trigger} note: … or ${trigger} action item: …`,
	].join("\n");
}
