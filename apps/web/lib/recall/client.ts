import type { RecallConfig, RecallTranscriptionProvider } from "./config";

const MAX_ATTEMPTS = 6;
const MAX_CALENDAR_EVENT_PAGES = 20;
const MAX_CONFLICT_RETRIES = 3;

export class RecallApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, message: string, body: unknown) {
		super(message);
		this.name = "RecallApiError";
		this.status = status;
		this.body = body;
	}
}

type RecallClientDeps = {
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
};

export type RecallBotStatusChange = {
	code: string;
	sub_code: string | null;
	created_at: string;
};

export type RecallBot = {
	id: string;
	status_changes: RecallBotStatusChange[];
	recordings: {
		id: string;
		media_shortcuts?: { video_mixed?: { data?: { download_url?: string } } };
	}[];
	platform?: string | null;
	slack_team?: { id: string } | null;
	meeting_metadata?: {
		title?: string | null;
		slack_channel_id?: string;
		slack_huddle_id?: string;
	} | null;
	meeting_url?: string | null;
};

export type RecallRecording = {
	id: string;
	status: { code: string };
	media_shortcuts: {
		video_mixed?: { data?: { download_url?: string } };
		transcript?: { id: string; data?: { download_url?: string } };
		participant_events?: {
			data?: { participant_events_download_url?: string };
		};
	};
};

export type RecallParticipantEvent = {
	id: string;
	action:
		| "join"
		| "leave"
		| "webcam_on"
		| "webcam_off"
		| "screenshare_on"
		| "screenshare_off"
		| "chat_message"
		| string;
	timestamp: { absolute: string; relative: number };
	participant: {
		id: number;
		name: string | null;
		is_host: boolean | null;
		email: string | null;
	};
	data: { text: string; to: string } | null;
};

export type RecallTranscript = {
	id: string;
	status: { code: string; sub_code?: string | null };
	data?: { download_url?: string };
};

export type RecallCalendar = {
	id: string;
	status: string;
	platform_email: string | null;
	platform: string;
};

export type RecallCalendarEvent = {
	id: string;
	start_time: string;
	end_time: string;
	calendar_id: string;
	meeting_url: string | null;
	meeting_platform: string | null;
	is_deleted: boolean;
	ical_uid: string;
	updated_at: string;
	raw:
		| {
				summary?: string;
				recurringEventId?: string;
				attendees?: {
					email?: string;
					self?: boolean;
					responseStatus?: string;
					resource?: boolean;
					displayName?: string;
				}[];
				organizer?: { email?: string; self?: boolean };
		  }
		| unknown;
	bots: {
		bot_id: string;
		deduplication_key: string;
		start_time: string;
		meeting_url: string;
	}[];
};

type RecallCalendarEventsPage = {
	next: string | null;
	results: RecallCalendarEvent[];
};

export type RecallAutomaticVideoOutput = {
	in_call_recording: { kind: "jpeg"; b64_data: string };
};

export type RecallBotConfig = {
	bot_name: string;
	chat?: {
		on_bot_join: { send_to: "everyone"; message: string; pin: boolean };
	};
	metadata?: Record<string, unknown>;
	automatic_video_output?: RecallAutomaticVideoOutput;
	recording_config?: RecordingConfig;
};

export type RecordingConfig = {
	video_mixed_mp4: Record<string, never>;
	participant_events: Record<string, never>;
	meeting_metadata: Record<string, never>;
	video_mixed_layout: "speaker_view";
	start_recording_on: "participant_join";
	transcript: {
		provider:
			| {
					recallai_streaming: {
						mode: "prioritize_low_latency";
						language_code: "en";
					};
			  }
			| {
					assembly_ai_v3_streaming: {
						speech_model: "universal-streaming-multilingual";
						language_detection: true;
						format_turns: true;
					};
			  };
		diarization: { use_separate_streams_when_available: true };
	};
	realtime_endpoints: {
		type: "webhook";
		url: string;
		events: ["transcript.data", "participant_events.chat_message"];
	}[];
};

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(
	status: number,
	retryAfterHeader: string | null,
	random: () => number,
): number | null {
	if (status === 429) {
		const seconds = Number(retryAfterHeader);
		const base = Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
		return base * 1000 + random() * 5000;
	}
	if (status === 503) return 10_000 + random() * 5000;
	if (status === 507) return 30_000 + random() * 5000;
	return null;
}

function requestPath(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.pathname}${parsed.search}`;
	} catch {
		return url;
	}
}

export function createRecallClient(
	config: RecallConfig,
	deps: RecallClientDeps = {},
) {
	const fetchImpl = deps.fetch ?? fetch;
	const sleepImpl = deps.sleep ?? defaultSleep;
	const random = deps.random ?? Math.random;

	async function fetchWithRetry(
		url: string,
		init: RequestInit,
	): Promise<Response> {
		for (let attempt = 1; ; attempt++) {
			const response = await fetchImpl(url, init);
			if (response.ok) return response;

			const delay = retryDelayMs(
				response.status,
				response.headers.get("retry-after"),
				random,
			);
			if (delay === null || attempt >= MAX_ATTEMPTS) return response;
			await sleepImpl(delay);
		}
	}

	async function request<T>(
		path: string,
		init: { method?: string; body?: unknown } = {},
	): Promise<T> {
		const response = await fetchWithRetry(`${config.baseUrl}${path}`, {
			method: init.method ?? "GET",
			headers: {
				Authorization: config.apiKey,
				accept: "application/json",
				...(init.body !== undefined
					? { "content-type": "application/json" }
					: {}),
			},
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		});

		if (response.ok) {
			if (response.status === 204) return undefined as T;
			return (await response.json()) as T;
		}

		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			body = null;
		}
		throw new RecallApiError(
			response.status,
			`Recall API request failed (${response.status})`,
			body,
		);
	}

	async function downloadJson<T>(url: string): Promise<T> {
		const response = await fetchWithRetry(url, {});
		if (!response.ok) {
			throw new RecallApiError(
				response.status,
				`Recall download failed (${response.status})`,
				null,
			);
		}
		return (await response.json()) as T;
	}

	async function createBot(params: {
		meetingUrl: string;
		joinAt: string;
		botName: string;
		metadata: Record<string, unknown>;
		joinChatMessage: string;
		automaticVideoOutput?: RecallAutomaticVideoOutput;
		recordingConfig?: RecordingConfig;
	}): Promise<{ id: string }> {
		return request("/api/v1/bot/", {
			method: "POST",
			body: {
				meeting_url: params.meetingUrl,
				join_at: params.joinAt,
				bot_name: params.botName,
				metadata: params.metadata,
				chat: {
					on_bot_join: {
						send_to: "everyone",
						message: params.joinChatMessage,
						pin: true,
					},
				},
				...(params.automaticVideoOutput
					? { automatic_video_output: params.automaticVideoOutput }
					: {}),
				...(params.recordingConfig
					? { recording_config: params.recordingConfig }
					: {}),
			},
		});
	}

	async function getBot(id: string): Promise<RecallBot> {
		return request(`/api/v1/bot/${id}/`);
	}

	async function sendChatMessage(
		id: string,
		params: { message: string; pin?: boolean },
	): Promise<void> {
		await request(`/api/v1/bot/${id}/send_chat_message/`, {
			method: "POST",
			body: {
				to: "everyone",
				message: params.message,
				...(params.pin ? { pin: true } : {}),
			},
		});
	}

	async function deleteScheduledBot(id: string): Promise<void> {
		try {
			await request<void>(`/api/v1/bot/${id}/`, { method: "DELETE" });
		} catch (error) {
			if (
				error instanceof RecallApiError &&
				error.status >= 400 &&
				error.status < 500
			) {
				return;
			}
			throw error;
		}
	}

	async function getRecording(id: string): Promise<RecallRecording> {
		return request(`/api/v1/recording/${id}/`);
	}

	async function createAsyncTranscript(
		recordingId: string,
		options: {
			provider?: RecallTranscriptionProvider;
			keyTerms?: string[];
			spelling?: { find: string[]; replace: string }[];
		} = {},
	): Promise<{ id: string }> {
		const keyTerms = options.keyTerms ?? [];
		const spelling = options.spelling ?? [];
		const provider =
			options.provider === "assemblyai"
				? {
						assembly_ai_async: {
							speech_models: ["universal-2"],
							language_detection: true,
							language_detection_options: { code_switching: true },
							...(keyTerms.length > 0 ? { keyterms_prompt: keyTerms } : {}),
							...(spelling.length > 0
								? {
										custom_spelling: spelling.map((entry) => ({
											from: entry.find,
											to: entry.replace,
										})),
									}
								: {}),
						},
					}
				: {
						recallai_async: {
							language_code: "auto",
							...(keyTerms.length > 0 ? { key_terms: keyTerms } : {}),
							...(spelling.length > 0 ? { spelling } : {}),
						},
					};
		return request(`/api/v1/recording/${recordingId}/create_transcript/`, {
			method: "POST",
			body: {
				provider,
				diarization: { use_separate_streams_when_available: true },
			},
		});
	}

	async function getTranscript(id: string): Promise<RecallTranscript> {
		return request(`/api/v1/transcript/${id}/`);
	}

	async function createCalendar(params: {
		platform: "google_calendar";
		oauthClientId: string;
		oauthClientSecret: string;
		oauthRefreshToken: string;
		oauthEmail?: string;
		metadata?: Record<string, unknown>;
	}): Promise<RecallCalendar> {
		return request("/api/v2/calendars/", {
			method: "POST",
			body: {
				platform: params.platform,
				oauth_client_id: params.oauthClientId,
				oauth_client_secret: params.oauthClientSecret,
				oauth_refresh_token: params.oauthRefreshToken,
				oauth_email: params.oauthEmail,
				metadata: params.metadata,
			},
		});
	}

	async function getCalendar(id: string): Promise<RecallCalendar> {
		return request(`/api/v2/calendars/${id}/`);
	}

	async function deleteCalendar(id: string): Promise<void> {
		return request(`/api/v2/calendars/${id}/`, { method: "DELETE" });
	}

	async function listCalendarEvents(params: {
		calendarId: string;
		updatedAtGte?: string;
		startTimeGte?: string;
		startTimeLte?: string;
		isDeleted?: boolean;
	}): Promise<RecallCalendarEvent[]> {
		const searchParams = new URLSearchParams({
			calendar_id: params.calendarId,
		});
		if (params.updatedAtGte)
			searchParams.set("updated_at__gte", params.updatedAtGte);
		if (params.startTimeGte)
			searchParams.set("start_time__gte", params.startTimeGte);
		if (params.startTimeLte)
			searchParams.set("start_time__lte", params.startTimeLte);
		if (params.isDeleted !== undefined)
			searchParams.set("is_deleted", String(params.isDeleted));

		const events: RecallCalendarEvent[] = [];
		let path: string | null =
			`/api/v2/calendar-events/?${searchParams.toString()}`;

		for (let page = 0; page < MAX_CALENDAR_EVENT_PAGES && path; page++) {
			const response: RecallCalendarEventsPage = await request(path);
			events.push(...response.results);
			path = response.next ? requestPath(response.next) : null;
		}

		return events;
	}

	async function getCalendarEvent(id: string): Promise<RecallCalendarEvent> {
		return request(`/api/v2/calendar-events/${id}/`);
	}

	async function scheduleCalendarEventBot(
		eventId: string,
		params: { deduplicationKey: string; botConfig: RecallBotConfig },
	): Promise<RecallCalendarEvent> {
		const path = `/api/v2/calendar-events/${eventId}/bot/`;
		const body = {
			deduplication_key: params.deduplicationKey,
			bot_config: params.botConfig,
		};

		for (let attempt = 0; ; attempt++) {
			try {
				return await request<RecallCalendarEvent>(path, {
					method: "POST",
					body,
				});
			} catch (error) {
				if (
					error instanceof RecallApiError &&
					error.status === 409 &&
					attempt < MAX_CONFLICT_RETRIES
				) {
					await sleepImpl(1000 * (attempt + 1) + random() * 1000);
					continue;
				}
				throw error;
			}
		}
	}

	async function removeCalendarEventBot(eventId: string): Promise<void> {
		try {
			await request<void>(`/api/v2/calendar-events/${eventId}/bot/`, {
				method: "DELETE",
			});
		} catch (error) {
			if (error instanceof RecallApiError && error.status === 404) return;
			throw error;
		}
	}

	async function activateSlackTeam(
		id: string,
		params: { botName: string },
	): Promise<void> {
		await request(`/api/v2/slack-teams/${id}/`, {
			method: "PATCH",
			body: { bot_name: params.botName },
		});
	}

	async function deleteSlackTeam(id: string): Promise<void> {
		try {
			await request<void>(`/api/v2/slack-teams/${id}/`, { method: "DELETE" });
		} catch (error) {
			if (error instanceof RecallApiError && error.status === 404) return;
			throw error;
		}
	}

	return {
		createBot,
		getBot,
		sendChatMessage,
		deleteScheduledBot,
		getRecording,
		createAsyncTranscript,
		getTranscript,
		downloadJson,
		createCalendar,
		getCalendar,
		deleteCalendar,
		listCalendarEvents,
		getCalendarEvent,
		scheduleCalendarEventBot,
		removeCalendarEventBot,
		activateSlackTeam,
		deleteSlackTeam,
	};
}

export type RecallClient = ReturnType<typeof createRecallClient>;
