import { getCurrentUser } from "@cap/database/auth/session";
import { Logo } from "@cap/ui";
import { redirect } from "next/navigation";
import {
	createPendingAuthorization,
	getPendingAuthorization,
} from "@/actions/oauth";
import { OAuthConsent } from "./Consent";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

const currentUrl = (searchParams: SearchParams) => {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(searchParams)) {
		const v = first(value);
		if (v) query.set(key, v);
	}
	return `/oauth/authorize?${query.toString()}`;
};

function ErrorCard({ message }: { message: string }) {
	return (
		<main className="flex justify-center items-center px-6 min-h-screen bg-gray-2">
			<section className="p-8 w-full max-w-md rounded-2xl border shadow-sm border-gray-4 bg-gray-1">
				<Logo className="mb-8 w-auto h-8" />
				<h1 className="text-xl font-semibold text-gray-12">
					Can't connect this agent
				</h1>
				<p className="mt-3 text-sm leading-6 text-gray-10">{message}</p>
			</section>
		</main>
	);
}

export default async function OAuthAuthorizePage(props: {
	searchParams: Promise<SearchParams>;
}) {
	const searchParams = await props.searchParams;
	const clientId = first(searchParams.client_id);
	const redirectUri = first(searchParams.redirect_uri);
	const responseType = first(searchParams.response_type);
	const codeChallenge = first(searchParams.code_challenge);
	const codeChallengeMethod = first(searchParams.code_challenge_method);
	const scope = first(searchParams.scope);
	const state = first(searchParams.state);
	const resource = first(searchParams.resource);

	if (
		!clientId ||
		!redirectUri ||
		!codeChallenge ||
		responseType !== "code" ||
		codeChallengeMethod !== "S256"
	) {
		return (
			<ErrorCard message="This authorization request is invalid. Return to the app and try connecting again." />
		);
	}

	const user = await getCurrentUser();
	if (!user) {
		redirect(`/login?next=${encodeURIComponent(currentUrl(searchParams))}`);
	}

	const created = await createPendingAuthorization({
		clientId,
		redirectUri,
		scope,
		state,
		codeChallenge,
		codeChallengeMethod: "S256",
		resource,
	});

	if ("error" in created) {
		return <ErrorCard message={created.error} />;
	}

	const pendingAuthorization = await getPendingAuthorization({
		requestId: created.requestId,
	});
	if (!pendingAuthorization) {
		return (
			<ErrorCard message="This request expired. Return to the app and try connecting again." />
		);
	}

	return (
		<OAuthConsent
			currentUrl={currentUrl(searchParams)}
			email={user.email}
			initialPendingAuthorization={pendingAuthorization}
		/>
	);
}
