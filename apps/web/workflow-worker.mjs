// Standalone workflow worker: polls the Postgres world's queue and executes
// steps by calling the web app over HTTP (WORKFLOW_LOCAL_BASE_URL). Runs as
// its own Railway service so Cap Web can sleep when idle.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// ESM imports ignore NODE_PATH, so resolve the world package from the
// directory the image installs it into (see Dockerfile.worker).
const worldDir = process.env.WORKFLOW_WORLD_DIR ?? "/app/workflow-world";
const require = createRequire(`${worldDir}/package.json`);
const { createWorld } = await import(
	pathToFileURL(require.resolve("@workflow/world-postgres")).href
);

if (!process.env.WORKFLOW_POSTGRES_URL) {
	console.error("WORKFLOW_POSTGRES_URL is required");
	process.exit(1);
}
if (!process.env.WORKFLOW_LOCAL_BASE_URL) {
	console.error("WORKFLOW_LOCAL_BASE_URL must point at the web app");
	process.exit(1);
}

const world = createWorld();
await world.start();
console.log(
	`Workflow worker running against ${process.env.WORKFLOW_LOCAL_BASE_URL}`,
);

const stop = async (signal) => {
	console.log(`Workflow worker stopping (${signal})`);
	try {
		await world.stop?.();
	} finally {
		process.exit(0);
	}
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
