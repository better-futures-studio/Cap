import { MeetingRecap } from "@cap/database/emails/meeting-recap";
import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

const props = {
	email: "ada@example.com",
	url: "https://cap.example.com/s/video_1",
	title: "Standup",
	date: "Thursday, Sep 3, 2026",
	duration: "10 min",
	summary: "We decided to ship the recap.",
	talkTime: null,
	actionItems: [] as {
		text: string;
		owner: string | null;
		due: string | null;
	}[],
	recapMode: "self",
	botName: "Meeting Notetaker",
	organizationName: "Acme",
};

describe("MeetingRecap", () => {
	it("renders the organization logo when logoUrl is set", async () => {
		const html = await render(
			MeetingRecap({
				...props,
				logoUrl: "https://cdn.example.com/organizations/org_1/icon.png",
			}),
		);
		expect(html).toContain(
			'src="https://cdn.example.com/organizations/org_1/icon.png"',
		);
		expect(html).toContain('alt="Acme"');
		expect(html).toContain("max-height:120px");
	});

	it("renders the organization name when logoUrl is missing", async () => {
		const html = await render(MeetingRecap({ ...props, logoUrl: null }));
		expect(html).not.toContain("<img");
		expect(html).toContain("Acme");
	});
});
