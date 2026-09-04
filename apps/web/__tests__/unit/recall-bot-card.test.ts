import { Effect, Option } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getRecallConfig: vi.fn(),
	getOrganizationWritableAccess: vi.fn(),
	getBucketAccess: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/schema", () => ({
	organizations: {
		id: "organizations.id",
		name: "organizations.name",
		iconUrl: "organizations.iconUrl",
	},
}));
vi.mock("drizzle-orm", () => ({
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
}));
vi.mock("@/lib/recall/config", () => ({
	DEFAULT_BOT_NAME: "Meeting Notetaker",
	getRecallConfig: mocks.getRecallConfig,
}));
vi.mock("@cap/web-backend", () => ({
	Storage: {
		getOrganizationWritableAccess: mocks.getOrganizationWritableAccess,
	},
	S3Buckets: {
		getBucketAccess: mocks.getBucketAccess,
	},
}));
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return {
		runPromise: (value: unknown) =>
			Effect.isEffect(value)
				? Effect.runPromise(value as Effect.Effect<unknown, unknown, never>)
				: value,
	};
});

import { GET } from "@/app/api/meeting-bot/card/route";
import { BOT_CARD_HEIGHT, BOT_CARD_WIDTH } from "@/lib/recall/bot-card";

const ICON_KEY = "organizations/org_1/icon.png";
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function orgClient(org: { name: string; iconUrl: string | null } | null) {
	return {
		select() {
			return {
				from() {
					return {
						where() {
							return {
								limit: async () => (org ? [org] : []),
							};
						},
					};
				},
			};
		},
	};
}

async function expectJpegCard(res: Response) {
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("image/jpeg");
	expect(res.headers.get("cache-control")).toContain("max-age=3600");
	const bytes = new Uint8Array(await res.arrayBuffer());
	expect(bytes[0]).toBe(0xff);
	expect(bytes[1]).toBe(0xd8);
	expect(bytes[2]).toBe(0xff);
	expect(bytes.byteLength).toBeLessThan(1_300_000);

	const sharp = (await import("sharp")).default;
	const meta = await sharp(bytes).metadata();
	expect(meta.width).toBe(BOT_CARD_WIDTH);
	expect(meta.height).toBe(BOT_CARD_HEIGHT);
	expect(meta.format).toBe("jpeg");
}

describe("GET /api/meeting-bot/card", () => {
	beforeEach(() => {
		mocks.getRecallConfig.mockReturnValue({ botName: "Meeting Notetaker" });
		mocks.db.mockReturnValue(orgClient({ name: "Acme", iconUrl: null }));
		mocks.getOrganizationWritableAccess.mockReturnValue(
			Effect.succeed(Option.none()),
		);
		mocks.getBucketAccess.mockReturnValue(
			Effect.succeed([
				{
					isPathStyle: false,
					getObject: () => Effect.succeed(Option.none()),
				},
			]),
		);
	});

	it("returns a 1280x720 JPEG for an organization", async () => {
		const res = await GET(
			new NextRequest("http://localhost:3000/api/meeting-bot/card?orgId=org_1"),
		);
		await expectJpegCard(res);
	});

	it("composites a storage-key organization icon from mocked storage bytes", async () => {
		const getObject = vi.fn(() => Effect.succeed(Option.some(PNG_1X1)));
		mocks.db.mockReturnValue(orgClient({ name: "Acme", iconUrl: ICON_KEY }));
		mocks.getOrganizationWritableAccess.mockReturnValue(
			Effect.succeed(
				Option.some({
					access: {
						isPathStyle: false,
						getObject,
					},
				}),
			),
		);

		const res = await GET(
			new NextRequest("http://localhost:3000/api/meeting-bot/card?orgId=org_1"),
		);
		await expectJpegCard(res);
		expect(getObject).toHaveBeenCalledWith(ICON_KEY);
		expect(mocks.getBucketAccess).not.toHaveBeenCalled();
	});
});
