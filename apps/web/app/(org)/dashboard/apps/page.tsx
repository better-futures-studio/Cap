import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppsPage } from "./AppsPage";

export const metadata: Metadata = {
	title: "Get the apps — Cap",
};

export default async function Page() {
	const user = await getCurrentUser();
	if (!user) redirect("/auth/signin");

	return <AppsPage webUrl={serverEnv().WEB_URL} />;
}
