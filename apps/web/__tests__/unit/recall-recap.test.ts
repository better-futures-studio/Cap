import type { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecallClient } from "@/lib/recall/client";
import {
	isRecapReady,
	resolveRecapRecipients,
	resolveRecapSender,
	sendMeetingRecap,
} from "@/lib/recall/recap";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	sendEmail: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: mocks.sendEmail,
	isAllowedFromDomain: (address: string, allowedDomain: string) => {
		const domain = address.split("@")[1]?.toLowerCase() ?? "";
		const allowed = allowedDomain.toLowerCase();
		return domain === allowed || domain.endsWith(`.${allowed}`);
	},
}));
vi.mock("@cap/web-backend", () => ({ ImageUploads: {} }));
vi.mock("@/lib/server", () => ({
	runPromise: () => {
		throw new Error("logo signing should not run without an icon");
	},
}));
vi.mock("@cap/database/emails/meeting-recap", () => ({
	MeetingRecap: (props: unknown) => props,
}));
vi.mock("@cap/database/schema", () => {
	const table = (name: string, fields: string[]) =>
		Object.fromEntries([
			["table", name],
			...fields.map((field) => [field, `${name}.${field}`]),
		]);
	return {
		meetingBots: table("meeting_bots", [
			"id",
			"orgId",
			"ownerId",
			"title",
			"joinAt",
			"calendarEventId",
			"recallRecordingId",
			"videoId",
			"recapSentAt",
			"status",
		]),
		meetingPreferences: table("meeting_preferences", ["userId", "recapMode"]),
		organizations: table("organizations", [
			"id",
			"name",
			"iconUrl",
			"settings",
		]),
		users: table("users", ["id", "email"]),
		videos: table("videos", [
			"id",
			"name",
			"metadata",
			"transcriptionStatus",
			"duration",
			"createdAt",
		]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
	isNull: (column: string) => ({ op: "isNull", column }),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://cap.example.com",
		RESEND_FROM_DOMAIN: "boca.pro",
	}),
}));
vi.mock("@/lib/recall/config", () => ({
	DEFAULT_BOT_NAME: "Meeting Notetaker",
	getRecallConfig: () => ({ botName: "Meeting Notetaker" }),
}));
vi.mock("@/lib/recall/default-client", () => ({
	getDefaultRecallClient: () => {
		throw new Error("default Recall client should not be used in tests");
	},
}));
vi.mock("@/lib/recall/visibility", () => ({
	shareMeetingRecordingWithAttendees: vi.fn(async () => undefined),
}));

type Row = Record<string, unknown>;
type Table = { table: string };
type Condition = {
	op: string;
	args?: (Condition | undefined)[];
	column?: string;
	value?: unknown;
};

const videoId = "video_1" as Video.VideoId;
const now = new Date("2026-09-03T16:00:00.000Z");

let rows: Record<string, Row[]>;

function matches(row: Row, condition?: Condition): boolean {
	if (!condition) return true;
	if (condition.op === "and") {
		return (condition.args ?? []).every((part) => matches(row, part));
	}
	const key = condition.column?.split(".")[1] ?? "";
	const value = row[key];
	if (condition.op === "isNull") return value === null || value === undefined;
	if (condition.op === "eq") return value === condition.value;
	throw new Error(`Unexpected condition ${condition.op}`);
}

function createClient() {
	return {
		select() {
			let table = "";
			let condition: Condition | undefined;
			const run = () =>
				(rows[table] ?? []).filter((row) => matches(row, condition));
			const query = {
				from(value: Table) {
					table = value.table;
					return query;
				},
				where(value: Condition) {
					condition = value;
					return query;
				},
				limit: async (limit: number) => run().slice(0, limit),
			};
			return query;
		},
		update(table: Table) {
			return {
				set(values: Row) {
					return {
						where: async (condition: Condition) => {
							const matching = (rows[table.table] ?? []).filter((row) =>
								matches(row, condition),
							);
							for (const row of matching) Object.assign(row, values);
							return [{ affectedRows: matching.length }];
						},
					};
				},
			};
		},
	};
}

function seedReadyMeeting(
	overrides: {
		recapMode?: string;
		recapSentAt?: Date | null;
		summary?: string;
		transcriptionStatus?: string;
		calendarEventId?: string | null;
		settings?: {
			recapFromName?: string;
			recapFromAddress?: string;
		} | null;
	} = {},
) {
	rows = {
		meeting_bots: [
			{
				id: "mb_1",
				orgId: "org_1",
				ownerId: "user_1",
				title: "Standup",
				joinAt: now,
				calendarEventId: overrides.calendarEventId ?? "evt_1",
				recallRecordingId: "rec_1",
				videoId,
				recapSentAt: overrides.recapSentAt ?? null,
				status: "complete",
			},
		],
		organizations: [
			{
				id: "org_1",
				name: "Acme",
				iconUrl: null,
				settings: overrides.settings ?? null,
			},
		],
		videos: [
			{
				id: videoId,
				name: "Standup",
				metadata: {
					summary: overrides.summary ?? "We decided to ship the recap.",
				},
				transcriptionStatus: overrides.transcriptionStatus ?? "COMPLETE",
				duration: 600,
				createdAt: now,
			},
		],
		users: [{ id: "user_1", email: "ada@example.com" }],
		meeting_preferences: overrides.recapMode
			? [{ userId: "user_1", recapMode: overrides.recapMode }]
			: [],
	};
	mocks.db.mockReturnValue(createClient());
}

function mockClient(overrides: Partial<RecallClient> = {}): RecallClient {
	return {
		getCalendarEvent: vi.fn(async () => ({
			id: "evt_1",
			raw: {
				attendees: [
					{ email: "ada@example.com" },
					{ email: "bea@example.com" },
					{ email: "room@resource.calendar.google.com", resource: true },
					{ email: "Meeting Notetaker" },
				],
			},
		})),
		...overrides,
	} as RecallClient;
}

beforeEach(() => {
	rows = {};
	mocks.sendEmail.mockReset().mockResolvedValue(undefined);
	mocks.db.mockReset();
});

describe("resolveRecapRecipients", () => {
	it("sends nothing when the mode is off", () => {
		expect(
			resolveRecapRecipients({
				mode: "off",
				ownerEmail: "ada@example.com",
				attendeeEmails: ["bea@example.com"],
			}),
		).toEqual([]);
	});

	it("sends only the owner in self mode", () => {
		expect(
			resolveRecapRecipients({
				mode: "self",
				ownerEmail: "Ada@example.com",
				attendeeEmails: ["bea@example.com"],
			}),
		).toEqual(["ada@example.com"]);
	});

	it("includes owner plus attendees, deduped and capped", () => {
		const extras = Array.from(
			{ length: 30 },
			(_, index) => `person${index}@example.com`,
		);
		expect(
			resolveRecapRecipients({
				mode: "attendees",
				ownerEmail: "ada@example.com",
				attendeeEmails: ["ADA@example.com", "bea@example.com", ...extras],
			}),
		).toHaveLength(25);
	});
});

describe("resolveRecapSender", () => {
	const botName = "Meeting Notetaker";
	const allowedDomain = "boca.pro";

	it("defaults to the bot name and no-reply address", () => {
		expect(
			resolveRecapSender({ settings: null, botName, allowedDomain }),
		).toEqual({
			from: "Meeting Notetaker <no-reply@boca.pro>",
			name: "Meeting Notetaker",
			address: "no-reply@boca.pro",
		});
	});

	it("uses the organization name and address override", () => {
		expect(
			resolveRecapSender({
				settings: {
					recapFromName: "Boca Pro",
					recapFromAddress: "notes@mail.boca.pro",
				},
				botName,
				allowedDomain,
			}),
		).toEqual({
			from: "Boca Pro <notes@mail.boca.pro>",
			name: "Boca Pro",
			address: "notes@mail.boca.pro",
		});
	});

	it("falls back when the override domain is not allowed", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(
			resolveRecapSender({
				settings: {
					recapFromName: "Boca Pro",
					recapFromAddress: "notes@evil.example",
				},
				botName,
				allowedDomain,
			}),
		).toEqual({
			from: "Boca Pro <no-reply@boca.pro>",
			name: "Boca Pro",
			address: "no-reply@boca.pro",
		});
		expect(warn).toHaveBeenCalledWith(
			"[recall] recap from address domain is not allowed",
			{ domain: "evil.example" },
		);
		warn.mockRestore();
	});
});

describe("isRecapReady", () => {
	it("requires a real summary and a complete transcript", () => {
		expect(
			isRecapReady({
				transcriptionStatus: "COMPLETE",
				metadata: { summary: "We decided to ship." },
			}),
		).toBe(true);
		expect(
			isRecapReady({
				transcriptionStatus: "COMPLETE",
				metadata: {
					summary:
						"The AI was unable to generate a proper summary for this content.",
				},
			}),
		).toBe(false);
		expect(
			isRecapReady({
				transcriptionStatus: "PROCESSING",
				metadata: { summary: "We decided to ship." },
			}),
		).toBe(false);
	});
});

describe("sendMeetingRecap", () => {
	it("skips when the video has no summary", async () => {
		seedReadyMeeting({ summary: "" });
		const client = mockClient();

		await expect(sendMeetingRecap("mb_1", { client })).resolves.toEqual({
			sent: false,
			recipients: 0,
		});
		expect(mocks.sendEmail).not.toHaveBeenCalled();
		expect(rows.meeting_bots?.[0]?.recapSentAt).toBeNull();
	});

	it("sends to the owner in the default self mode", async () => {
		seedReadyMeeting();
		const client = mockClient();

		await expect(sendMeetingRecap("mb_1", { client })).resolves.toEqual({
			sent: true,
			recipients: 1,
		});
		expect(mocks.sendEmail).toHaveBeenCalledOnce();
		expect(mocks.sendEmail.mock.calls[0]?.[0]).toMatchObject({
			email: "ada@example.com",
			subject: "Recap: Standup",
			fromOverride: "Meeting Notetaker <no-reply@boca.pro>",
			react: {
				botName: "Meeting Notetaker",
				organizationName: "Acme",
				logoUrl: null,
			},
		});
		expect(rows.meeting_bots?.[0]?.recapSentAt).toBeInstanceOf(Date);
	});

	it("uses the organization sender override and signed logo URL", async () => {
		seedReadyMeeting({
			settings: {
				recapFromName: "Boca Pro",
				recapFromAddress: "notes@boca.pro",
			},
		});
		const organizations = rows.organizations ?? [];
		if (organizations[0])
			organizations[0].iconUrl = "organizations/org_1/1.png";
		const client = mockClient();

		await expect(
			sendMeetingRecap("mb_1", {
				client,
				resolveLogoUrl: async () =>
					"https://signed.example/organizations/org_1/1.png",
			}),
		).resolves.toEqual({ sent: true, recipients: 1 });
		expect(mocks.sendEmail.mock.calls[0]?.[0]).toMatchObject({
			fromOverride: "Boca Pro <notes@boca.pro>",
			react: {
				logoUrl: "https://signed.example/organizations/org_1/1.png",
			},
		});
	});

	it("includes calendar attendees when the mode is attendees", async () => {
		seedReadyMeeting({ recapMode: "attendees" });
		const client = mockClient();

		await expect(sendMeetingRecap("mb_1", { client })).resolves.toEqual({
			sent: true,
			recipients: 2,
		});
		expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
		expect(mocks.sendEmail.mock.calls.map((call) => call[0]?.email)).toEqual([
			"ada@example.com",
			"bea@example.com",
		]);
	});

	it("sends nothing when the mode is off", async () => {
		seedReadyMeeting({ recapMode: "off" });
		const client = mockClient();

		await expect(sendMeetingRecap("mb_1", { client })).resolves.toEqual({
			sent: false,
			recipients: 0,
		});
		expect(mocks.sendEmail).not.toHaveBeenCalled();
		expect(rows.meeting_bots?.[0]?.recapSentAt).toBeNull();
	});

	it("is a no-op when recapSentAt is already set", async () => {
		seedReadyMeeting({ recapSentAt: now });
		const client = mockClient();

		await expect(sendMeetingRecap("mb_1", { client })).resolves.toEqual({
			sent: false,
			recipients: 0,
		});
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});

	it("resets the claim when sending fails", async () => {
		seedReadyMeeting();
		mocks.sendEmail.mockRejectedValue(new Error("Postmark 500"));
		const client = mockClient();

		await expect(sendMeetingRecap("mb_1", { client })).rejects.toThrow(
			"Postmark 500",
		);
		expect(rows.meeting_bots?.[0]?.recapSentAt).toBeNull();
	});
});
