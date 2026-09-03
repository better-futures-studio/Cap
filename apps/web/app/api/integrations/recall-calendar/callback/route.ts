import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { meetingCalendars } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Organisation } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import {
	exchangeGoogleCode,
	fetchGoogleUserEmail,
} from "@/lib/recall/calendar-oauth";
import {
	getRecallConfig,
	isRecallCalendarConfigured,
} from "@/lib/recall/config";
import { getDefaultRecallClient } from "@/lib/recall/default-client";
import { verifyOAuthState } from "@/lib/recall/oauth-state";
import { apiToHandler } from "@/lib/server";

const CallbackParams = Schema.Struct({
	code: Schema.optional(Schema.String),
	state: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
});

class Api extends HttpApi.make("CapRecallCalendarCallbackApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get(
			"completeRecallCalendarConnect",
		)`/api/integrations/recall-calendar/callback`.setUrlParams(CallbackParams),
	),
) {}

const meetingsPath = "/dashboard/meetings";
const redirectToMeetings = (result: string) => {
	const url = new URL(meetingsPath, serverEnv().WEB_URL);
	url.searchParams.set("calendar", result);
	return HttpServerResponse.redirect(url, { status: 302 });
};

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("completeRecallCalendarConnect", ({ urlParams }) =>
				Effect.tryPromise(async () => {
					if (urlParams.error) return redirectToMeetings("cancelled");

					const config = getRecallConfig();
					if (
						!config ||
						!config.calendarGoogle ||
						!isRecallCalendarConfigured() ||
						!urlParams.code ||
						!urlParams.state
					) {
						return redirectToMeetings("invalid");
					}

					const state = verifyOAuthState({
						state: urlParams.state,
						secret: config.calendarGoogle.clientSecret,
					});
					const user = await getCurrentUser();
					if (!state || !user || state.userId !== user.id) {
						return redirectToMeetings("invalid");
					}

					const organizationId = Organisation.OrganisationId.make(
						state.organizationId,
					);
					await requireOrganizationAccess(user.id, organizationId);

					const redirectUri = new URL(
						"/api/integrations/recall-calendar/callback",
						serverEnv().WEB_URL,
					).toString();
					const tokens = await exchangeGoogleCode({
						code: urlParams.code,
						clientId: config.calendarGoogle.clientId,
						clientSecret: config.calendarGoogle.clientSecret,
						redirectUri,
					});
					const email = await fetchGoogleUserEmail({
						accessToken: tokens.accessToken,
					});

					const client = getDefaultRecallClient();
					const calendar = await client.createCalendar({
						platform: "google_calendar",
						oauthClientId: config.calendarGoogle.clientId,
						oauthClientSecret: config.calendarGoogle.clientSecret,
						oauthRefreshToken: tokens.refreshToken,
						oauthEmail: email ?? undefined,
						metadata: { cap_org_id: organizationId, cap_user_id: user.id },
					});

					await db()
						.insert(meetingCalendars)
						.values({
							id: nanoId(),
							orgId: organizationId,
							userId: user.id,
							recallCalendarId: calendar.id,
							platform: "google_calendar",
							platformEmail: calendar.platform_email ?? email,
							status: "connecting",
							autoRecord: false,
						})
						.onDuplicateKeyUpdate({
							set: {
								platformEmail: calendar.platform_email ?? email,
								status: "connecting",
								updatedAt: new Date(),
							},
						});

					return redirectToMeetings("connected");
				}).pipe(
					Effect.catchAll((error) => {
						console.error(
							"[recall] calendar OAuth callback failed",
							error instanceof Error ? error.message : "Unknown error",
						);
						return Effect.succeed(redirectToMeetings("failed"));
					}),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
