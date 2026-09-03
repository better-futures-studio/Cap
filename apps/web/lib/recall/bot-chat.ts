import type { RecallConfig } from "./config";

export function buildJoinChatMessage(
	config: Pick<RecallConfig, "botName" | "liveAgent" | "agentTrigger">,
): string {
	const recording = `${config.botName} is recording this meeting.`;
	if (!config.liveAgent) return recording;

	const trigger = config.agentTrigger;
	return [
		recording,
		[
			`Ask me anything with ${trigger}, for example:`,
			`${trigger} summarize`,
			`${trigger} action items`,
			`${trigger} catch me up`,
			`${trigger} what's the weather in Tampa?`,
		].join("\n"),
		[
			"Save a note to the recording:",
			`${trigger} note: …`,
			`${trigger} action item: …`,
		].join("\n"),
	].join("\n\n");
}
