import { buildEnv, serverEnv } from "@cap/env";
import type { JSXElementConstructor, ReactElement } from "react";
import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import { Resend } from "resend";

export const resend = () =>
	serverEnv().RESEND_API_KEY ? new Resend(serverEnv().RESEND_API_KEY) : null;

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
	let from: string;

	if (fromOverride) from = fromOverride;
	else if (marketing) from = "Richie from Cap <richie@send.cap.so>";
	else if (buildEnv.NEXT_PUBLIC_IS_CAP)
		from = "Cap Auth <no-reply@auth.cap.so>";
	else from = `auth@${serverEnv().RESEND_FROM_DOMAIN}`;

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
					Content: Buffer.from(a.content).toString("base64"),
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
