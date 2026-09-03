import { serverEnv } from "@cap/env";

type ServerEnv = ReturnType<typeof serverEnv>;

const DEFAULT_REGION = "us-west-2";
const DEFAULT_BOT_NAME = "Boca Pro Notetaker";

export type RecallConfig = {
	apiKey: string;
	region: string;
	baseUrl: string;
	verificationSecret: string | null;
	botName: string;
	publicBaseUrl: string;
	botImageUrl: string;
	liveAgent: boolean;
	agentTrigger: string;
	calendarGoogle: { clientId: string; clientSecret: string } | null;
};

export function getRecallConfig(
	env: ServerEnv = serverEnv(),
): RecallConfig | null {
	if (!env.RECALL_API_KEY) return null;

	const region = env.RECALL_REGION || DEFAULT_REGION;

	return {
		apiKey: env.RECALL_API_KEY,
		region,
		baseUrl: `https://${region}.recall.ai`,
		verificationSecret: env.RECALL_WEBHOOK_VERIFICATION_SECRET ?? null,
		botName: env.RECALL_BOT_NAME || DEFAULT_BOT_NAME,
		publicBaseUrl: env.WEB_URL,
		botImageUrl:
			env.RECALL_BOT_IMAGE_URL ||
			`${env.WEB_URL.replace(/\/$/, "")}/meeting-bot/recording.jpg`,
		liveAgent: env.RECALL_LIVE_AGENT,
		agentTrigger: env.RECALL_AGENT_TRIGGER || "@notetaker",
		calendarGoogle:
			env.RECALL_CALENDAR_GOOGLE_CLIENT_ID &&
			env.RECALL_CALENDAR_GOOGLE_CLIENT_SECRET
				? {
						clientId: env.RECALL_CALENDAR_GOOGLE_CLIENT_ID,
						clientSecret: env.RECALL_CALENDAR_GOOGLE_CLIENT_SECRET,
					}
				: null,
	};
}

export function isRecallConfigured(env?: ServerEnv): boolean {
	return getRecallConfig(env) !== null;
}

export function isRecallCalendarConfigured(env?: ServerEnv): boolean {
	return getRecallConfig(env)?.calendarGoogle != null;
}
