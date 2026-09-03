import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import { buildGoogleCalendarAuthUrl } from "@/lib/recall/calendar-oauth";
import {
	getRecallConfig,
	isRecallCalendarConfigured,
} from "@/lib/recall/config";
import { createOAuthState } from "@/lib/recall/oauth-state";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("CapRecallCalendarConnectApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get(
			"connectRecallCalendar",
		)`/api/integrations/recall-calendar/connect`,
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
			handlers.handle("connectRecallCalendar", () =>
				Effect.gen(function* () {
					const user = yield* Effect.tryPromise(getCurrentUser);
					if (!user) {
						const signInUrl = new URL("/login", serverEnv().WEB_URL);
						signInUrl.searchParams.set("next", meetingsPath);
						return HttpServerResponse.redirect(signInUrl, { status: 302 });
					}

					const config = getRecallConfig();
					if (
						!config ||
						!config.calendarGoogle ||
						!isRecallCalendarConfigured() ||
						!user.activeOrganizationId
					) {
						return redirectToMeetings("not-configured");
					}

					const organizationId = user.activeOrganizationId;
					yield* Effect.tryPromise(() =>
						requireOrganizationAccess(user.id, organizationId),
					);

					const state = createOAuthState({
						organizationId,
						userId: user.id,
						secret: config.calendarGoogle.clientSecret,
					});
					const redirectUri = new URL(
						"/api/integrations/recall-calendar/callback",
						serverEnv().WEB_URL,
					).toString();

					return HttpServerResponse.redirect(
						buildGoogleCalendarAuthUrl({
							clientId: config.calendarGoogle.clientId,
							redirectUri,
							state,
						}),
						{ status: 302 },
					);
				}).pipe(
					Effect.catchAll(() => Effect.succeed(redirectToMeetings("failed"))),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
