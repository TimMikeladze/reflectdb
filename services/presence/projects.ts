/**
 * Project lookup and per-project limits.
 *
 * Redis is the source of truth: a key lives at `{prefix}:key:{apiKey}` as a
 * hash. That keeps this service free of any control-plane concern — issuing,
 * revoking and billing keys is somebody else's write to the same hash, and
 * this process only ever reads.
 *
 * `PRESENCE_PROJECTS` seeds keys at boot so a self-hosted or first-deploy
 * instance works before any control plane exists.
 */

import type { RedisLike } from "../../src/server/ephemeral/redis.ts";

export interface Project {
	projectId: string;
	/** Concurrent connections allowed across the fleet. */
	maxConnections: number;
	/** Published frames per connection per second. */
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
	return { projectId, ...DEFAULT_LIMITS, ...overrides };
}

function fieldsFromHash(reply: unknown): Record<string, string> {
	if (Array.isArray(reply)) {
		const out: Record<string, string> = {};
		for (let i = 0; i + 1 < reply.length; i += 2) {
			out[String(reply[i])] = String(reply[i + 1]);
		}
		return out;
	}
	if (reply && typeof reply === "object") {
		return Object.fromEntries(
			Object.entries(reply as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
		);
	}
	return {};
}

function numberOr(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ProjectRegistryConfig {
	client: RedisLike;
	prefix?: string;
	/**
	 * Seed definitions, as `{ "<apiKey>": { projectId, maxConnections, … } }`.
	 * Written on boot; existing Redis entries win, so a control-plane update is
	 * never clobbered by a redeploy.
	 */
	seed?: Record<string, Partial<Project> & { projectId: string }>;
	/** How long a resolved key is cached in-process. Default 30s. */
	cacheTtlMs?: number;
}

export interface ProjectRegistry {
	seed(): Promise<number>;
	resolve(apiKey: string): Promise<Project | null>;
	/** Reserve a connection slot. Returns false when the project is at its cap. */
	acquireConnection(project: Project): Promise<boolean>;
	releaseConnection(project: Project): Promise<void>;
	connectionCount(projectId: string): Promise<number>;
}

export function createProjectRegistry(config: ProjectRegistryConfig): ProjectRegistry {
	const client = config.client;
	const prefix = config.prefix ?? "presence";
	const cacheTtlMs = config.cacheTtlMs ?? 30_000;

	const keyHash = (apiKey: string) => `${prefix}:key:${apiKey}`;
	const connKey = (projectId: string) => `${prefix}:conn:${projectId}`;

	const cache = new Map<string, { project: Project | null; expiresAt: number }>();

	return {
		async seed(): Promise<number> {
			if (!config.seed) return 0;
			let written = 0;
			for (const [apiKey, definition] of Object.entries(config.seed)) {
				const project = withDefaults(definition.projectId, definition);
				// HSETNX per field: a control plane that has already tuned a limit
				// keeps its value across deploys of this service.
				for (const [field, value] of Object.entries(project)) {
					await client.call("HSETNX", keyHash(apiKey), field, String(value));
				}
				written++;
			}
			return written;
		},

		async resolve(apiKey: string): Promise<Project | null> {
			const now = Date.now();
			const cached = cache.get(apiKey);
			if (cached && cached.expiresAt > now) return cached.project;

			const fields = fieldsFromHash(await client.call("HGETALL", keyHash(apiKey)));
			const projectId = fields.projectId;
			const project: Project | null = projectId
				? {
						projectId,
						maxConnections: numberOr(fields.maxConnections, DEFAULT_LIMITS.maxConnections),
						maxMessagesPerSecond: numberOr(
							fields.maxMessagesPerSecond,
							DEFAULT_LIMITS.maxMessagesPerSecond,
						),
						maxEntriesPerRoom: numberOr(
							fields.maxEntriesPerRoom,
							DEFAULT_LIMITS.maxEntriesPerRoom,
						),
						defaultTtlMs: numberOr(fields.defaultTtlMs, DEFAULT_LIMITS.defaultTtlMs),
						maxTtlMs: numberOr(fields.maxTtlMs, DEFAULT_LIMITS.maxTtlMs),
					}
				: null;

			// Misses are cached too, so an invalid key sprayed at the service
			// costs one Redis read per cache window rather than one per attempt.
			cache.set(apiKey, { project, expiresAt: now + cacheTtlMs });
			return project;
		},

		async acquireConnection(project: Project): Promise<boolean> {
			const count = Number(await client.call("INCR", connKey(project.projectId)));
			if (count > project.maxConnections) {
				await client.call("DECR", connKey(project.projectId));
				return false;
			}
			// Expiry is a self-heal: if an instance dies without releasing, the
			// counter cannot strand a project above its cap forever.
			await client.call("EXPIRE", connKey(project.projectId), 3600);
			return true;
		},

		async releaseConnection(project: Project): Promise<void> {
			const count = Number(await client.call("DECR", connKey(project.projectId)));
			if (count < 0) await client.call("SET", connKey(project.projectId), "0");
		},

		async connectionCount(projectId: string): Promise<number> {
			const reply = await client.call("GET", connKey(projectId));
			return reply == null ? 0 : Number(reply);
		},
	};
}
