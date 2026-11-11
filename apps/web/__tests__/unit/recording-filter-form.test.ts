// @vitest-environment jsdom

import { act, createElement, type HTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
	push: vi.fn(),
	search: "",
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: navigation.push }),
	usePathname: () => "/dashboard/meetings",
	useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("@cap/ui", () => ({
	Input: (props: HTMLAttributes<HTMLInputElement>) =>
		createElement("input", props),
	Button: ({
		spinner: _spinner,
		variant: _variant,
		...props
	}: HTMLAttributes<HTMLButtonElement> & {
		spinner?: boolean;
		variant?: string;
	}) => createElement("button", { type: "button", ...props }),
}));

import { RecordingFilters } from "@/components/RecordingFilters";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	navigation.search =
		"tab=past&page=3&q=Planning&sort=oldest&from=2026-11-08T00%3A00%3A00.000Z&to=2026-11-10T00%3A00%3A00.000Z";
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(RecordingFilters)));
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("recording filter form", () => {
	it("restores filters and submits them without the old page number", async () => {
		const search = container.querySelector<HTMLInputElement>(
			'input[type="search"]',
		);
		const form = container.querySelector("form");
		if (!form || !search) throw new Error("Missing form");
		expect(search.value).toBe("Planning");
		search.value = "  Retrospective  ";
		await act(async () =>
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			),
		);
		const href = navigation.push.mock.calls[0]?.[0];
		const url = new URL(href, "https://cap.test");
		expect(url.searchParams.get("q")).toBe("Retrospective");
		expect(url.searchParams.get("tab")).toBe("past");
		expect(url.searchParams.get("sort")).toBe("oldest");
		expect(url.searchParams.has("page")).toBe(false);
		expect(url.searchParams.has("from")).toBe(true);
		expect(url.searchParams.has("to")).toBe(true);
	});

	it("clears filters while preserving the meeting tab", async () => {
		const clear = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Clear filters",
		);
		if (!clear) throw new Error("Missing clear button");
		await act(async () => clear.click());
		expect(navigation.push).toHaveBeenCalledWith(
			"/dashboard/meetings?tab=past",
			{ scroll: false },
		);
		expect(
			Array.from(
				container.querySelectorAll<HTMLInputElement>('input[type="date"]'),
			).map((input) => input.value),
		).toEqual(["", ""]);
	});

	it("resets an unapplied search even when the URL is already clear", async () => {
		navigation.search = "tab=past";
		await act(async () => root.render(createElement(RecordingFilters)));
		const search = container.querySelector<HTMLInputElement>(
			'input[type="search"]',
		);
		const clear = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Clear filters",
		);
		if (!search || !clear) throw new Error("Missing search controls");
		search.value = "Unapplied search";
		await act(async () => clear.click());
		expect(search.value).toBe("");
	});

	it("restores fields after browser navigation changes the URL", async () => {
		navigation.search = "tab=past&q=Standup&sort=newest";
		await act(async () => root.render(createElement(RecordingFilters)));
		expect(
			container.querySelector<HTMLInputElement>('input[type="search"]')?.value,
		).toBe("Standup");
		expect(container.querySelector("select")?.value).toBe("newest");
	});
});
