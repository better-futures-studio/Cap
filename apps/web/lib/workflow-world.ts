export const WORKFLOW_POSTGRES_WORLD = "@workflow/world-postgres";

export function applyWorkflowWorldSelection(
	env: Record<string, string | undefined>,
): string | undefined {
	if (env.WORKFLOW_POSTGRES_URL && !env.WORKFLOW_TARGET_WORLD) {
		env.WORKFLOW_TARGET_WORLD = WORKFLOW_POSTGRES_WORLD;
	}
	return env.WORKFLOW_TARGET_WORLD;
}

export function isPostgresWorkflowWorld(
	env: Record<string, string | undefined>,
): boolean {
	return (
		Boolean(env.WORKFLOW_POSTGRES_URL) &&
		env.WORKFLOW_TARGET_WORLD === WORKFLOW_POSTGRES_WORLD
	);
}

export async function bootstrapPostgresWorkflowWorld(): Promise<void> {
	const { spawn } = await import("node:child_process");
	const { createRequire } = await import("node:module");
	const { dirname, join } = await import("node:path");

	const require = createRequire(join(process.cwd(), "index.js"));
	const setupScript = join(
		dirname(require.resolve("@workflow/world-postgres")),
		"..",
		"bin",
		"setup.js",
	);

	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [setupScript], {
			env: process.env,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else {
				reject(
					new Error(`Postgres workflow bootstrap exited with code ${code}`),
				);
			}
		});
	});
}

export async function startSelectedWorkflowWorld(): Promise<void> {
	await import("@workflow/world-postgres");
	const { getWorld } = await import("workflow/runtime");
	await getWorld().start?.();
}
