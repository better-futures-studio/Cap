import { buildEnv, serverEnv } from "@cap/env";
import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import type { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";

export const resend = () =>
	serverEnv().RESEND_API_KEY ? new Resend(serverEnv().RESEND_API_KEY) : null;

export function parseEmailFromAddress(from: string): string | null {
	const angled = from.match(/<([^>]+)>/);
	const address = (angled?.[1] ?? from).trim();
	return address.includes("@") ? address : null;
}

export function isAllowedFromDomain(
	address: string,
	allowedDomain: string,
): boolean {
	const domain = parseEmailFromAddress(address)?.split("@")[1]?.toLowerCase();
	const allowed = allowedDomain.trim().toLowerCase().replace(/^\./, "");
	if (!domain || !allowed) return false;
	return domain === allowed || domain.endsWith(`.${allowed}`);
}

function defaultFromAddress(marketing?: boolean): string {
	if (marketing) return "Richie from Cap <richie@send.cap.so>";
	if (buildEnv.NEXT_PUBLIC_IS_CAP) return "Cap Auth <no-reply@auth.cap.so>";
	return `auth@${serverEnv().RESEND_FROM_DOMAIN}`;
}

function resolveFromAddress(
	fromOverride: string | undefined,
	marketing?: boolean,
): string {
	if (!fromOverride) return defaultFromAddress(marketing);
	const allowedDomain = serverEnv().RESEND_FROM_DOMAIN?.trim() ?? "";
	if (!allowedDomain || isAllowedFromDomain(fromOverride, allowedDomain)) {
		return fromOverride;
	}
	const domain = parseEmailFromAddress(fromOverride)?.split("@")[1] ?? "";
	if (domain) {
		console.warn("[email] from override domain is not allowed", { domain });
	}
	return defaultFromAddress(marketing);
}

export const sendEmail = async ({
	email,
	subject,
	react,
	marketing,
	test,
	scheduledAt,
	cc,
	replyTo,
	fromOverride,
	idempotencyKey,
	attachments,
}: {
	email: string;
	subject: string;
	react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
	marketing?: boolean;
	test?: boolean;
	scheduledAt?: string;
	cc?: string | string[];
	replyTo?: string;
	fromOverride?: string;
	idempotencyKey?: string;
	attachments?: {
		filename: string;
		content: Buffer | string;
		contentType?: string;
	}[];
}) => {
	const r = resend();
	const smtpUrl = serverEnv().SMTP_URL;
	const postmarkToken = serverEnv().POSTMARK_SERVER_TOKEN;
	if (!r && !smtpUrl && !postmarkToken) {
		return Promise.resolve();
	}

	if (marketing && !buildEnv.NEXT_PUBLIC_IS_CAP) return;
	const from = resolveFromAddress(fromOverride, marketing);

	if (!r && postmarkToken) {
		const html = await render(react);
		const res = await fetch("https://api.postmarkapp.com/email", {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"X-Postmark-Server-Token": postmarkToken,
			},
			body: JSON.stringify({
				From: from,
				To: email,
				Subject: subject,
				HtmlBody: html,
				Cc: Array.isArray(cc) ? cc.join(",") : cc,
				ReplyTo: replyTo,
				MessageStream: "outbound",
				Attachments: attachments?.map((a) => ({
					Name: a.filename,
					Content:
						typeof a.content === "string"
							? Buffer.from(a.content).toString("base64")
							: a.content.toString("base64"),
					ContentType: a.contentType ?? "application/octet-stream",
				})),
			}),
		});
		if (!res.ok) {
			throw new Error(`Postmark ${res.status}: ${await res.text()}`);
		}
		return;
	}

	if (!r) {
		// ponytail: plain SMTP path for self-hosters without Resend. No
		// scheduling or idempotency; add if a self-hosted flow needs them.
		await nodemailer.createTransport(smtpUrl).sendMail({
			from,
			to: email,
			subject,
			html: await render(react),
			cc,
			replyTo,
			attachments,
		});
		return;
	}

	return r.emails.send(
		{
			from,
			to: test ? "delivered@resend.dev" : email,
			subject,
			react,
			scheduledAt,
			cc: test ? undefined : cc,
			replyTo: replyTo,
			attachments,
		},
		idempotencyKey ? { idempotencyKey } : undefined,
	);
};
