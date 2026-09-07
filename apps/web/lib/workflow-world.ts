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
	const { createRequire } = await import("node:module");
	const { dirname, join } = await import("node:path");
	const { Pool } = await import("pg");
	const { drizzle } = await import("drizzle-orm/node-postgres");
	const { migrate } = await import("drizzle-orm/node-postgres/migrator");
	const { makeWorkerUtils } = await import("graphile-worker");

	const require = createRequire(join(process.cwd(), "index.js"));
	const migrationsFolder = join(
		dirname(require.resolve("@workflow/world-postgres/package.json")),
		"src",
		"drizzle",
		"migrations",
	);
	const pool = new Pool({
		connectionString: process.env.WORKFLOW_POSTGRES_URL,
		max: 1,
	});
	try {
		await migrate(drizzle(pool), {
			migrationsFolder,
			migrationsTable: "workflow_migrations",
			migrationsSchema: "workflow_drizzle",
		});
		const workerUtils = await makeWorkerUtils({ pgPool: pool });
		try {
			await workerUtils.migrate();
		} finally {
			await workerUtils.release();
		}
	} finally {
		await pool.end().catch(() => {});
	}
}

export async function startSelectedWorkflowWorld(): Promise<void> {
	await import("@workflow/world-postgres");
	const { getWorld } = await import("workflow/runtime");
	await getWorld().start?.();
}
