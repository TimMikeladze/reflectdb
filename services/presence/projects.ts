/**
 * Project lookup and per-project limits.
 *
 * Postgres is the source of truth: a key lives as a row in `presence_key`.
 * That keeps this service free of any control-plane concern — issuing,
 * revoking and billing keys is somebody else's write to the same table, and
 * this process only ever reads.
 *
 * `PRESENCE_PROJECTS` seeds keys so a self-hosted or first-deploy instance
 * works before any control plane exists.
 */

import type { PresenceStore, SqlClient } from "./store.js";

export interface Project {
	projectId: string;
	/** Distinct clients allowed to hold live state in the project at once. */
	maxConnections: number;
	/** Writes accepted per second, per client, per channel. */
	maxMessagesPerSecond: number;
	/** Entries one room may hold, across all channels. */
	maxEntriesPerRoom: number;
	/** Applied when a client omits `ttlMs`, and as the ceiling when it doesn't. */
	defaultTtlMs: number;
	maxTtlMs: number;
}

export const DEFAULT_LIMITS: Omit<Project, "projectId"> = {
	maxConnections: 100,
	maxMessagesPerSecond: 30,
	maxEntriesPerRoom: 200,
	defaultTtlMs: 30_000,
	maxTtlMs: 5 * 60_000,
};

/** Free-tier shape, used when a seeded project omits limits. */
function withDefaults(projectId: string, overrides: Partial<Project> = {}): Project {
	const merged = { projectId, ...DEFAULT_LIMITS, ...overrides };
	// A seed entry carrying `projectId: undefined` would otherwise win over the
	// argument and produce a project nothing can be attributed to.
	merged.projectId = projectId;
	return merged;
}

export const PROJECTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS presence_key (
  api_key                 text PRIMARY KEY,
  project_id              text NOT NULL,
  max_connections         int,
  max_messages_per_second int,
  max_entries_per_room    int,
  default_ttl_ms          bigint,
  max_ttl_ms              bigint
);
`;

function numberOr(value: unknown, fallback: number): number {
	if (value === null || value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type SeedDefinition = Partial<Project> & { projectId: string };

export interface ProjectRegistryConfig {
	sql: SqlClient;
	/**
	 * Seed definitions, as `{ "<apiKey>": { projectId, maxConnections, … } }`.
	 * Written once; an existing row wins, so a control-plane update is never
	 * clobbered by a redeploy.
	 */
	seed?: Record<string, SeedDefinition>;
	/** How long a resolved key is cached in-process. Default 30s. */
	cacheTtlMs?: number;
	/** Run `CREATE TABLE IF NOT EXISTS` and the seed lazily. Default true. */
	migrate?: boolean;
}

export interface ProjectRegistry {
	resolve(apiKey: string): Promise<Project | null>;
	/**
	 * Whether a client may take a slot in the project.
	 *
	 * Approximate by construction. There is no socket to count with SSE — a
	 * stream is a request that ends every minute — so occupancy is measured as
	 * "distinct clients holding live state", which counts a client that has
	 * gone away until its entries expire.
	 */
	hasCapacity(project: Project, clientId: string): Promise<boolean>;
	clientCount(projectId: string): Promise<number>;
}

export function createProjectRegistry(
	config: ProjectRegistryConfig & { store: PresenceStore },
): ProjectRegistry {
	const sql = config.sql;
	const cacheTtlMs = config.cacheTtlMs ?? 30_000;
	const cache = new Map<string, { project: Project | null; expiresAt: number }>();
	let migration: Promise<void> | null = null;

	async function ready(): Promise<void> {
		if (config.migrate === false) return;
		migration ??= (async () => {
			await sql.query(PROJECTS_SCHEMA_SQL);
			for (const [apiKey, definition] of Object.entries(config.seed ?? {})) {
				const project = withDefaults(definition.projectId, definition);
				await sql.query(
					`INSERT INTO presence_key
					   (api_key, project_id, max_connections, max_messages_per_second,
					    max_entries_per_room, default_ttl_ms, max_ttl_ms)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)
					 ON CONFLICT (api_key) DO NOTHING`,
					[
						apiKey,
						project.projectId,
						project.maxConnections,
						project.maxMessagesPerSecond,
						project.maxEntriesPerRoom,
						project.defaultTtlMs,
						project.maxTtlMs,
					],
				);
			}
		})();
		await migration;
	}

	return {
		async resolve(apiKey: string): Promise<Project | null> {
			const now = Date.now();
			const cached = cache.get(apiKey);
			if (cached && cached.expiresAt > now) return cached.project;

			await ready();
			const { rows } = await sql.query(
				`SELECT project_id, max_connections, max_messages_per_second,
				        max_entries_per_room, default_ttl_ms, max_ttl_ms
				   FROM presence_key WHERE api_key = $1`,
				[apiKey],
			);
			const row = rows[0];
			const project: Project | null = row
				? {
						projectId: String(row.project_id),
						maxConnections: numberOr(row.max_connections, DEFAULT_LIMITS.maxConnections),
						maxMessagesPerSecond: numberOr(
							row.max_messages_per_second,
							DEFAULT_LIMITS.maxMessagesPerSecond,
						),
						maxEntriesPerRoom: numberOr(row.max_entries_per_room, DEFAULT_LIMITS.maxEntriesPerRoom),
						defaultTtlMs: numberOr(row.default_ttl_ms, DEFAULT_LIMITS.defaultTtlMs),
						maxTtlMs: numberOr(row.max_ttl_ms, DEFAULT_LIMITS.maxTtlMs),
					}
				: null;

			// Misses are cached too, so an invalid key sprayed at the service
			// costs one query per cache window rather than one per attempt.
			cache.set(apiKey, { project, expiresAt: now + cacheTtlMs });
			return project;
		},

		async hasCapacity(project: Project, clientId: string): Promise<boolean> {
			const count = await config.store.countClients(project.projectId);
			if (count < project.maxConnections) return true;
			// A client already inside the project is not a new occupant: it is
			// reconnecting after a stream recycle, which happens to everyone
			// every minute. Counting it again would put a full project into a
			// loop where its own users are evicted as they reconnect.
			return config.store.hasClient(project.projectId, clientId);
		},

		async clientCount(projectId: string): Promise<number> {
			return config.store.countClients(projectId);
		},
	};
}

/**
 * A registry that resolves keys straight from the seed, with no database.
 *
 * For tests and for a local run: `bun services/presence/dev.ts` with
 * `PRESENCE_STORE=memory` needs no Postgres at all, and a protocol test should
 * not have to stand one up to check that a bad key is refused.
 */
export function createStaticRegistry(
	seed: Record<string, SeedDefinition>,
	store: PresenceStore,
): ProjectRegistry {
	const byKey = new Map<string, Project>(
		Object.entries(seed).map(([apiKey, definition]) => [
			apiKey,
			withDefaults(definition.projectId, definition),
		]),
	);
	return {
		async resolve(apiKey: string): Promise<Project | null> {
			return byKey.get(apiKey) ?? null;
		},
		async hasCapacity(project: Project, clientId: string): Promise<boolean> {
			const count = await store.countClients(project.projectId);
			if (count < project.maxConnections) return true;
			return store.hasClient(project.projectId, clientId);
		},
		async clientCount(projectId: string): Promise<number> {
			return store.countClients(projectId);
		},
	};
}

/** Parse `PRESENCE_PROJECTS`, or refuse to start. */
export function parseSeed(raw: string | undefined): Record<string, SeedDefinition> | undefined {
	if (!raw) return undefined;
	let parsed: Record<string, SeedDefinition>;
	try {
		parsed = JSON.parse(raw) as Record<string, SeedDefinition>;
	} catch (err) {
		// Refusing to boot beats booting with no valid keys and rejecting every
		// client with "unknown API key" until somebody reads the logs.
		throw new Error(
			`PRESENCE_PROJECTS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	for (const [apiKey, definition] of Object.entries(parsed)) {
		if (!definition?.projectId) {
			throw new Error(`PRESENCE_PROJECTS entry "${apiKey}" is missing projectId`);
		}
	}
	return parsed;
}
