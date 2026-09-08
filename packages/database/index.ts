import { instrumentDrizzleClient } from "@kubiks/otel-drizzle";
import { sql } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";

function createDrizzle() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL not found");

	if (!url.startsWith("mysql://"))
		throw new Error("DATABASE_URL is not a MySQL URL");

	// Idle connections send TCP keepalives, which Railway counts as outbound
	// traffic and which keep a serverless service from sleeping. Close idle
	// connections quickly and let the pool reconnect on the next query.
	return drizzle({
		connection: {
			uri: url,
			enableKeepAlive: false,
			idleTimeout: 30_000,
			maxIdle: 0,
		},
	});
}

let _cached: ReturnType<typeof createDrizzle> | undefined;

export const db = () => {
	if (!_cached) {
		_cached = createDrizzle();

		instrumentDrizzleClient(_cached);
	}
	return _cached;
};

// Use the incoming value if one exists, else fallback to the DBs existing value.
export const updateIfDefined = <T>(v: T | undefined, col: AnyMySqlColumn) =>
	sql`COALESCE(${v === undefined ? sql`NULL` : v}, ${col})`;
