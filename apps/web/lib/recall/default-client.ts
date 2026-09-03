import { createRecallClient, type RecallClient } from "./client";
import { getRecallConfig } from "./config";

export function getDefaultRecallClient(): RecallClient {
	const config = getRecallConfig();
	if (!config) throw new Error("Recall is not configured");
	return createRecallClient(config);
}
