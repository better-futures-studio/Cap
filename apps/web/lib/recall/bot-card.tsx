import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { ImageResponse } from "next/og";
import sharp from "sharp";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./config";

export const BOT_CARD_WIDTH = 1280;
export const BOT_CARD_HEIGHT = 720;
const CARD_CACHE_CONTROL = "public, max-age=3600";
const MAX_CARD_BYTES = 1_300_000;
const ICON_SIZE = 180;

export type BotCardOrganization = {
	name: string;
	iconSrc: string | null;
};

export async function loadBotCardOrganization(
	orgId: string,
): Promise<BotCardOrganization | null> {
	const [org] = await db()
		.select({
			name: organizations.name,
			iconUrl: organizations.iconUrl,
		})
		.from(organizations)
		.where(eq(organizations.id, Organisation.OrganisationId.make(orgId)))
		.limit(1);
	if (!org) return null;
	const iconUrl = org.iconUrl?.trim() ?? "";
	return {
		name: org.name.trim(),
		iconSrc: /^https?:\/\//i.test(iconUrl) ? iconUrl : null,
	};
}

function cardElement(input: { heading: string | null; botName: string }) {
	return (
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				backgroundColor: "#ffffff",
				color: "#111111",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					height: ICON_SIZE,
					fontSize: 72,
					fontWeight: 600,
					textAlign: "center",
					paddingLeft: 80,
					paddingRight: 80,
				}}
			>
				{input.heading ?? ""}
			</div>
			<div style={{ fontSize: 40, fontWeight: 500, marginTop: 32 }}>
				{input.botName}
			</div>
			<div style={{ fontSize: 28, color: "#555555", marginTop: 12 }}>
				Recording in progress
			</div>
		</div>
	);
}

async function loadIconBuffer(iconSrc: string): Promise<Buffer | null> {
	try {
		const response = await fetch(iconSrc);
		if (!response.ok) return null;
		return sharp(Buffer.from(await response.arrayBuffer()))
			.resize(ICON_SIZE, ICON_SIZE, {
				fit: "contain",
				background: { r: 255, g: 255, b: 255, alpha: 1 },
			})
			.png()
			.toBuffer();
	} catch {
		return null;
	}
}

export async function renderMeetingBotCard(input: {
	orgName: string | null;
	iconSrc: string | null;
	botName: string;
}): Promise<Response> {
	const icon = input.iconSrc ? await loadIconBuffer(input.iconSrc) : null;
	const png = await new ImageResponse(
		cardElement({
			heading: icon ? null : input.orgName,
			botName: input.botName,
		}),
		{
			width: BOT_CARD_WIDTH,
			height: BOT_CARD_HEIGHT,
		},
	).arrayBuffer();

	let image = sharp(Buffer.from(png));
	if (icon) {
		image = image.composite([
			{
				input: icon,
				top: Math.round((BOT_CARD_HEIGHT - ICON_SIZE) / 2) - 80,
				left: Math.round((BOT_CARD_WIDTH - ICON_SIZE) / 2),
			},
		]);
	}
	const jpeg = await image.jpeg({ quality: 80 }).toBuffer();
	if (jpeg.byteLength > MAX_CARD_BYTES) {
		return new Response("Card too large", { status: 500 });
	}
	return new Response(jpeg, {
		headers: {
			"Content-Type": "image/jpeg",
			"Cache-Control": CARD_CACHE_CONTROL,
		},
	});
}

export async function meetingBotCardResponse(orgId: string | null) {
	const botName = getRecallConfig()?.botName ?? DEFAULT_BOT_NAME;
	const org = orgId ? await loadBotCardOrganization(orgId) : null;
	return renderMeetingBotCard({
		orgName: org?.name ?? null,
		iconSrc: org?.iconSrc ?? null,
		botName,
	});
}
