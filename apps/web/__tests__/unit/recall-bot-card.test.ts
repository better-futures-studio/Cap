import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getRecallConfig: vi.fn(),
}));

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

import { GET } from "@/app/api/meeting-bot/card/route";
import { BOT_CARD_HEIGHT, BOT_CARD_WIDTH } from "@/lib/recall/bot-card";

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

describe("GET /api/meeting-bot/card", () => {
	beforeEach(() => {
		mocks.getRecallConfig.mockReturnValue({ botName: "Meeting Notetaker" });
		mocks.db.mockReturnValue(orgClient({ name: "Acme", iconUrl: null }));
	});

	it("returns a 1280x720 JPEG for an organization", async () => {
		const res = await GET(
			new NextRequest("http://localhost:3000/api/meeting-bot/card?orgId=org_1"),
		);
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
	});
});
