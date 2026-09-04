import { serverEnv } from "@cap/env";

type ServerEnv = ReturnType<typeof serverEnv>;

const DEFAULT_REGION = "us-west-2";
export const DEFAULT_BOT_NAME = "Meeting Notetaker";
export const DEFAULT_MEDIA_RETENTION_HOURS = 168;

export type RecallTranscriptionProvider = "recallai" | "assemblyai";

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
	transcriptionProvider: RecallTranscriptionProvider;
	calendarGoogle: { clientId: string; clientSecret: string } | null;
	mediaRetentionHours: number;
	deleteMediaAfterImport: boolean;
};

function stripTrailingSlash(url: string): string {
	return url.replace(/\/$/, "");
}

export function defaultBotCardUrl(publicBaseUrl: string): string {
	return `${stripTrailingSlash(publicBaseUrl)}/api/meeting-bot/card`;
}

export function botImageUrlForOrg(
	config: Pick<RecallConfig, "botImageUrl" | "publicBaseUrl">,
	orgId: string,
): string {
	const cardUrl = defaultBotCardUrl(config.publicBaseUrl);
	if (config.botImageUrl !== cardUrl) {
		return config.botImageUrl;
	}
	const url = new URL(cardUrl);
	url.searchParams.set("orgId", orgId);
	return url.toString();
}

export function getRecallConfig(
	env: ServerEnv = serverEnv(),
): RecallConfig | null {
	if (!env.RECALL_API_KEY) return null;

	const region = env.RECALL_REGION || DEFAULT_REGION;
	const publicBaseUrl = env.WEB_URL;

	return {
		apiKey: env.RECALL_API_KEY,
		region,
		baseUrl: `https://${region}.recall.ai`,
		verificationSecret: env.RECALL_WEBHOOK_VERIFICATION_SECRET ?? null,
		botName: env.RECALL_BOT_NAME || DEFAULT_BOT_NAME,
		publicBaseUrl,
		botImageUrl: env.RECALL_BOT_IMAGE_URL || defaultBotCardUrl(publicBaseUrl),
		liveAgent: env.RECALL_LIVE_AGENT,
		agentTrigger: env.RECALL_AGENT_TRIGGER || "/nt",
		transcriptionProvider:
			env.RECALL_TRANSCRIPTION_PROVIDER === "assemblyai"
				? "assemblyai"
				: "recallai",
		calendarGoogle:
			env.RECALL_CALENDAR_GOOGLE_CLIENT_ID &&
			env.RECALL_CALENDAR_GOOGLE_CLIENT_SECRET
				? {
						clientId: env.RECALL_CALENDAR_GOOGLE_CLIENT_ID,
						clientSecret: env.RECALL_CALENDAR_GOOGLE_CLIENT_SECRET,
					}
				: null,
		mediaRetentionHours:
			env.RECALL_MEDIA_RETENTION_HOURS ?? DEFAULT_MEDIA_RETENTION_HOURS,
		deleteMediaAfterImport: env.RECALL_DELETE_MEDIA_AFTER_IMPORT ?? true,
	};
}

export function isRecallConfigured(env?: ServerEnv): boolean {
	return getRecallConfig(env) !== null;
}

export function isRecallCalendarConfigured(env?: ServerEnv): boolean {
	return getRecallConfig(env)?.calendarGoogle != null;
}
