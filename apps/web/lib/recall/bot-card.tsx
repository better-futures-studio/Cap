import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { S3Buckets, Storage } from "@cap/web-backend";
import { ImageUpload, Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { ImageResponse } from "next/og";
import sharp from "sharp";
import { runPromise } from "@/lib/server";
import { DEFAULT_BOT_NAME, getRecallConfig } from "./config";

export const BOT_CARD_WIDTH = 1280;
export const BOT_CARD_HEIGHT = 720;
const CARD_CACHE_CONTROL = "public, max-age=3600";
const MAX_CARD_BYTES = 1_300_000;
const SAFE_MARGIN = 120;
const ICON_BOX_WIDTH = 720;
const ICON_BOX_HEIGHT = 260;
const ICON_TEXT_GAP = 32;
const BOT_NAME_SIZE = 56;
const BOT_NAME_HEIGHT = 64;
const STATUS_SIZE = 28;
const STATUS_HEIGHT = 36;
const STATUS_GAP = 12;

const ICON_STACK_HEIGHT =
	ICON_BOX_HEIGHT +
	ICON_TEXT_GAP +
	BOT_NAME_HEIGHT +
	STATUS_GAP +
	STATUS_HEIGHT;
const ICON_STACK_TOP =
	SAFE_MARGIN + (BOT_CARD_HEIGHT - SAFE_MARGIN * 2 - ICON_STACK_HEIGHT) / 2;
const ICON_BOX_LEFT = (BOT_CARD_WIDTH - ICON_BOX_WIDTH) / 2;
const ICON_BOX_TOP = ICON_STACK_TOP;
const BOT_NAME_TOP = ICON_BOX_TOP + ICON_BOX_HEIGHT + ICON_TEXT_GAP;
const STATUS_TOP = BOT_NAME_TOP + BOT_NAME_HEIGHT + STATUS_GAP;

export type BotCardOrganization = {
	name: string;
	iconUrl: string | null;
};

type IconReader = {
	isPathStyle?: boolean;
	getObject: (key: string) => Effect.Effect<Option.Option<unknown>, unknown>;
	getInternalSignedObjectUrl?: (key: string) => Effect.Effect<string, unknown>;
	getSignedObjectUrl?: (key: string) => Effect.Effect<string, unknown>;
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
	return {
		name: org.name.trim(),
		iconUrl: org.iconUrl?.trim() || null,
	};
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

function iconBytesFromObject(value: unknown): Buffer | null {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	if (value instanceof ArrayBuffer) return Buffer.from(value);
	if (typeof value === "string" && value.length > 0) return Buffer.from(value);
	return null;
}

async function fetchIconBytes(url: string): Promise<Buffer | null> {
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		return Buffer.from(await response.arrayBuffer());
	} catch {
		return null;
	}
}

async function rasterizeIcon(input: Buffer): Promise<Buffer | null> {
	try {
		return await sharp(input, { density: 300 })
			.resize(ICON_BOX_WIDTH, ICON_BOX_HEIGHT, { fit: "inside" })
			.png()
			.toBuffer();
	} catch {
		return null;
	}
}

function storageObjectKey(iconUrl: string, isPathStyle: boolean): string {
	return Option.getOrElse(
		ImageUpload.extractFileKey(
			iconUrl as ImageUpload.ImageUrlOrKey,
			isPathStyle,
		),
		() => iconUrl,
	);
}

function signedReadUrl(
	access: IconReader,
	key: string,
): Effect.Effect<string, unknown> | null {
	if (access.getInternalSignedObjectUrl) {
		return access.getInternalSignedObjectUrl(key);
	}
	if (access.getSignedObjectUrl) {
		return access.getSignedObjectUrl(key);
	}
	return null;
}

function readIconFromAccess(access: IconReader, iconUrl: string) {
	return Effect.gen(function* () {
		const key = storageObjectKey(iconUrl, access.isPathStyle ?? false);
		const object = yield* access.getObject(key);
		const objectBytes = Option.isSome(object)
			? iconBytesFromObject(object.value)
			: null;
		const fromObject = objectBytes
			? yield* Effect.promise(() => rasterizeIcon(objectBytes))
			: null;
		if (fromObject) return fromObject;

		const signed = signedReadUrl(access, key);
		if (!signed) return null;
		const url = yield* signed;
		const fetched = yield* Effect.promise(() => fetchIconBytes(url));
		return fetched ? yield* Effect.promise(() => rasterizeIcon(fetched)) : null;
	});
}

async function loadIconFromStorage(
	orgId: string,
	iconUrl: string,
): Promise<Buffer | null> {
	try {
		return await Effect.gen(function* () {
			const organizationId = Organisation.OrganisationId.make(orgId);
			const orgAccess =
				yield* Storage.getOrganizationWritableAccess(organizationId);
			if (Option.isSome(orgAccess)) {
				const fromOrg = yield* readIconFromAccess(
					orgAccess.value.access as IconReader,
					iconUrl,
				);
				if (fromOrg) return fromOrg;
			}

			const [defaultBucket] = yield* S3Buckets.getBucketAccess(Option.none());
			return yield* readIconFromAccess(defaultBucket as IconReader, iconUrl);
		}).pipe(runPromise);
	} catch {
		return null;
	}
}

export async function resolveCardIcon(
	orgId: string | null,
	iconUrl: string | null,
): Promise<Buffer | null> {
	if (!iconUrl) return null;
	if (isHttpUrl(iconUrl)) {
		const fetched = await fetchIconBytes(iconUrl);
		return fetched ? rasterizeIcon(fetched) : null;
	}
	if (!orgId) return null;
	return loadIconFromStorage(orgId, iconUrl);
}

function cardElement(input: {
	heading: string | null;
	hasIcon: boolean;
	botName: string;
}) {
	if (input.hasIcon) {
		return (
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					backgroundColor: "#ffffff",
					color: "#111111",
					position: "relative",
				}}
			>
				<div
					style={{
						position: "absolute",
						left: SAFE_MARGIN,
						top: BOT_NAME_TOP,
						width: BOT_CARD_WIDTH - SAFE_MARGIN * 2,
						height: BOT_NAME_HEIGHT,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						fontSize: BOT_NAME_SIZE,
						fontWeight: 600,
						textAlign: "center",
					}}
				>
					{input.botName}
				</div>
				<div
					style={{
						position: "absolute",
						left: SAFE_MARGIN,
						top: STATUS_TOP,
						width: BOT_CARD_WIDTH - SAFE_MARGIN * 2,
						height: STATUS_HEIGHT,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						fontSize: STATUS_SIZE,
						color: "#555555",
						textAlign: "center",
					}}
				>
					Recording in progress
				</div>
			</div>
		);
	}

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
				paddingLeft: SAFE_MARGIN,
				paddingRight: SAFE_MARGIN,
				paddingTop: SAFE_MARGIN,
				paddingBottom: SAFE_MARGIN,
			}}
		>
			{input.heading ? (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						fontSize: 72,
						fontWeight: 600,
						textAlign: "center",
					}}
				>
					{input.heading}
				</div>
			) : null}
			<div
				style={{
					fontSize: BOT_NAME_SIZE,
					fontWeight: 600,
					marginTop: ICON_TEXT_GAP,
				}}
			>
				{input.botName}
			</div>
			<div
				style={{
					fontSize: STATUS_SIZE,
					color: "#555555",
					marginTop: STATUS_GAP,
				}}
			>
				Recording in progress
			</div>
		</div>
	);
}

export async function renderMeetingBotCard(input: {
	orgName: string | null;
	icon: Buffer | null;
	botName: string;
}): Promise<Response> {
	const png = await new ImageResponse(
		cardElement({
			heading: input.icon ? null : input.orgName,
			hasIcon: Boolean(input.icon),
			botName: input.botName,
		}),
		{
			width: BOT_CARD_WIDTH,
			height: BOT_CARD_HEIGHT,
		},
	).arrayBuffer();

	let image = sharp(Buffer.from(png));
	if (input.icon) {
		const meta = await sharp(input.icon).metadata();
		const iconWidth = meta.width ?? ICON_BOX_WIDTH;
		const iconHeight = meta.height ?? ICON_BOX_HEIGHT;
		image = image.composite([
			{
				input: input.icon,
				top: Math.round(ICON_BOX_TOP + (ICON_BOX_HEIGHT - iconHeight) / 2),
				left: Math.round(ICON_BOX_LEFT + (ICON_BOX_WIDTH - iconWidth) / 2),
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
	const icon = await resolveCardIcon(orgId, org?.iconUrl ?? null);
	return renderMeetingBotCard({
		orgName: org?.name ?? null,
		icon,
		botName,
	});
}
