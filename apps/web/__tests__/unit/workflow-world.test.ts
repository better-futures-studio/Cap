import { describe, expect, it } from "vitest";
import {
	applyWorkflowWorldSelection,
	WORKFLOW_POSTGRES_WORLD,
} from "@/lib/workflow-world";

describe("applyWorkflowWorldSelection", () => {
	it("sets the postgres target when WORKFLOW_POSTGRES_URL is set", () => {
		const env: Record<string, string | undefined> = {
			WORKFLOW_POSTGRES_URL: "postgres://world:world@localhost:5432/world",
		};

		expect(applyWorkflowWorldSelection(env)).toBe(WORKFLOW_POSTGRES_WORLD);
		expect(env.WORKFLOW_TARGET_WORLD).toBe(WORKFLOW_POSTGRES_WORLD);
	});

	it("leaves WORKFLOW_TARGET_WORLD untouched when the URL is unset", () => {
		const env: Record<string, string | undefined> = {};

		expect(applyWorkflowWorldSelection(env)).toBeUndefined();
		expect(env.WORKFLOW_TARGET_WORLD).toBeUndefined();
	});

	it("does not override an explicit WORKFLOW_TARGET_WORLD", () => {
		const env: Record<string, string | undefined> = {
			WORKFLOW_POSTGRES_URL: "postgres://world:world@localhost:5432/world",
			WORKFLOW_TARGET_WORLD: "local",
		};

		expect(applyWorkflowWorldSelection(env)).toBe("local");
		expect(env.WORKFLOW_TARGET_WORLD).toBe("local");
	});
});
