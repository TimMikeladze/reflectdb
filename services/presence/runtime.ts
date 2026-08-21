/**
 * Process-wide wiring: one pool, one store, one service.
 *
 * Deliberately module scope. A serverless instance serves many requests before
 * it is recycled, and building a connection pool per request would spend the
 * platform's whole concurrency budget on Postgres handshakes — and, on a small
 * database, exhaust `max_connections` long before it exhausted anything else.
 * Everything here is created on first use and reused for the life of the
 * instance.
 */

import pg from "pg";
import { createPresenceService, type PresenceService } from "./service.js";
import { createStaticRegistry, parseSeed } from "./projects.js";
import {
	createMemoryStore,
	createPostgresStore,
	type PresenceStore,
	type SqlClient,
} from "./store.js";

/**
 * Run without a database.
 *
 * Only ever right for one process: a memory store is invisible across
 * instances, so two visitors served by different machines would each see an
 * empty room. It exists so `bun services/presence/dev.ts` starts with nothing
 * installed, and is checked by name rather than inferred from a missing
 * `PRESENCE_DATABASE_URL` — a deploy that lost its database URL should fail
 * loudly, not quietly serve everyone their own private room.
 */
const MEMORY_MODE = process.env.PRESENCE_STORE === "memory";

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		// Failing at the first request beats serving a service that rejects
		// every client with an unexplained 503.
		throw new Error(`${name} is not set`);
	}
	return value;
}

function numberFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let pool: pg.Pool | null = null;
let service: PresenceService | null = null;
let store: PresenceStore | null = null;

export function getPool(): pg.Pool {
	pool ??= new pg.Pool({
		connectionString: required("PRESENCE_DATABASE_URL"),
		// Small on purpose. Every warm instance holds its own pool, so the
		// fleet's connection count is this number times however many instances
		// the platform decides to run — and presence queries are milliseconds
		// long, so depth buys nothing.
		max: numberFromEnv("PRESENCE_POOL_MAX", 3),
		idleTimeoutMillis: 10_000,
		connectionTimeoutMillis: 5_000,
		// Opt in explicitly rather than let the driver guess: a database that
		// does not offer TLS fails the handshake rather than falling back
		// silently, which is the behaviour you want to notice.
		ssl: process.env.PRESENCE_DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
	});
	return pool;
}

export function getSql(): SqlClient {
	const p = getPool();
	return {
		query: (text: string, values?: unknown[]) =>
			p.query(text, values as unknown[] | undefined) as Promise<{
				rows: Record<string, unknown>[];
			}>,
	};
}

export function getStore(): PresenceStore {
	store ??= MEMORY_MODE
		? createMemoryStore()
		: createPostgresStore({ sql: getSql(), onClose: () => pool?.end() });
	return store;
}

export function getService(): PresenceService {
	const seed = parseSeed(process.env.PRESENCE_PROJECTS);
	service ??= createPresenceService({
		store: getStore(),
		...(MEMORY_MODE
			? { registry: createStaticRegistry(seed ?? {}, getStore()) }
			: { sql: getSql(), seed }),
		streamMs: numberFromEnv("PRESENCE_STREAM_MS", 55_000),
		fastPollMs: numberFromEnv("PRESENCE_FAST_POLL_MS", 200),
		idlePollMs: numberFromEnv("PRESENCE_IDLE_POLL_MS", 1_000),
	});
	return service;
}

/**
 * Origins allowed to call the service.
 *
 * A presence key ships inside a static bundle by design, so the origin list is
 * the only thing separating "the demo page uses this key" from "any page
 * does". `*` is the default because the service is public, but a deployment
 * with a paid tier will want to pin it.
 */
export function allowedOrigin(requestOrigin: string | undefined): string | null {
	const configured = process.env.PRESENCE_ALLOWED_ORIGINS?.trim();
	if (!configured || configured === "*") return "*";
	const allowed = configured
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (!requestOrigin) return null;
	return allowed.includes(requestOrigin) ? requestOrigin : null;
}
