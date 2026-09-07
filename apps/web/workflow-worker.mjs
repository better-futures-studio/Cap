// Standalone workflow worker: polls the Postgres world's queue and executes
// steps by calling the web app over HTTP (WORKFLOW_LOCAL_BASE_URL). Runs as
// its own Railway service so Cap Web can sleep when idle.
import { createWorld } from "@workflow/world-postgres";

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
