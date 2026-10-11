/**
 * Postgres-backed ephemeral adapter — shared presence state plus a cross-instance
 * bus, for deployments that already have Postgres and no Redis.
 *
 * Built for serverless as much as for a fleet: on Vercel or Lambda every request
 * is a separate process, so the in-process adapter cannot even show presence to
 * two tabs of the same user. Here the state lives in one table every invocation
 * reads, and LISTEN/NOTIFY carries each event to the invocations holding the
 * other clients' streams.
 *
 * Layout, under `tablePrefix` (default `_reflectdb_eph`):
 *
 *   {p}  TABLE  (room, key, client_id) -> user_id, data JSONB, updated_at, expires_at
 *   NOTIFY channel `channel` (default `reflectdb_eph`)  EphemeralBroadcast, JSON
 *
 * NOTIFY payloads are capped by Postgres at 8000 bytes. Presence and cursors fit
 * comfortably; a larger event is refused by `publish` (the handler logs it, and
 * peers still see the state on their next join snapshot).
 *
 * LISTEN does not survive a transaction-mode pooler (PgBouncer, Supavisor, Neon's
 * pooled endpoint): notifications reach whichever client the pooler last handed
 * the backend to. Behind one, pass `bus: { poll: ms }` instead — events go to a
 * `{p}_bus` table that each subscriber polls, at the cost of one small SELECT per
 * tick:
 *
 *   {p}_bus  TABLE  id BIGSERIAL -> payload JSONB, created_at  (trimmed by cleanupExpired)
 *
 * The polled bus is at-most-once, like NOTIFY: an insert that commits after a
 * later id was already read is skipped. For presence that costs one frame until
 * the peer's next update; do not carry anything on it that must arrive.
 */

import type { PostgresClient } from "../storage/postgres.ts";
import type { EphemeralAdapter, EphemeralBroadcast, EphemeralState } from "./types.ts";

/**
 * LISTEN seam. LISTEN needs one dedicated connection (a pooled one is handed
 * back and stops receiving), and every driver exposes notifications its own way,
 * so wire yours in a few lines rather than have this module guess:
 *
 * ```ts
 * // node-postgres
 * const listen = new pg.Client(url);
 * await listen.connect();
 * const listener = {
 *   listen: async (channel, onPayload) => {
 *     listen.on("notification", (m) => { if (m.channel === channel && m.payload) onPayload(m.payload); });
 *     await listen.query(`LISTEN ${channel}`);
 *   },
 * };
 *
 * // postgres.js
 * const listener = { listen: (channel, onPayload) => sql.listen(channel, onPayload) };
 * ```
 */
export interface PostgresListenerLike {
	listen(channel: string, onPayload: (payload: string) => void): Promise<unknown> | unknown;
}

export interface PostgresEphemeralConfig {
	/** Query connection or pool (pg.Pool, Neon, anything with `query(text, values)`). */
	client: PostgresClient;
	/**
	 * How events cross instances. Default `"notify"` (LISTEN/NOTIFY through
	 * `listener`). `{ poll: ms }` writes events to a table and polls it — use it
	 * behind a transaction-mode pooler, where LISTEN does not work.
	 */
	bus?: "notify" | { poll: number };
	/**
	 * Dedicated LISTEN connection (notify bus). Omit to run shared-state-only — peers then
	 * see each other's presence on join, but not live. A process that only
	 * publishes (a serverless POST handler) does not need one.
	 */
	listener?: PostgresListenerLike;
	/** Table name. Default: "_reflectdb_eph" */
	tablePrefix?: string;
	/** NOTIFY channel. Default: "reflectdb_eph" */
	channel?: string;
	/** Global entry ceiling across the fleet. Default: 100_000 */
	maxEntries?: number;
	/**
	 * Safety-net expiry for entries published without a TTL, in ms. Guards
	 * against a crashed instance leaving entries behind when its clients never
	 * disconnect cleanly. Default: 24h, matching the handler's TTL clamp.
	 */
	maxAgeMs?: number;
}

const DEFAULT_PREFIX = "_reflectdb_eph";
const DEFAULT_CHANNEL = "reflectdb_eph";
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Postgres rejects NOTIFY payloads of 8000 bytes or more. */
const MAX_NOTIFY_BYTES = 7_999;
/** Polled bus events are kept this long — far past any poll interval. */
const BUS_RETENTION_MS = 60_000;
/** Rows removed per expiry sweep. Bounds the lock footprint of one tick. */
const SWEEP_BATCH = 1_000;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

type Row = {
	room: string;
	key: string;
	client_id: string;
	user_id: string;
	data: Record<string, unknown> | string;
	updated_at: string | number;
	expires_at: string | number | null;
	ttl_ms: string | number | null;
};

export function createPostgresEphemeral(
	config: PostgresEphemeralConfig,
): EphemeralAdapter & { ready(): Promise<void>; ensureSchema(): Promise<void> } {
	const client = config.client;
	const table = config.tablePrefix ?? DEFAULT_PREFIX;
	const channel = config.channel ?? DEFAULT_CHANNEL;
	const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	// Both are interpolated into SQL (identifiers cannot be parameters), so they
	// are validated rather than escaped.
	if (!IDENTIFIER.test(table)) throw new Error(`Invalid tablePrefix: ${table}`);
	if (!IDENTIFIER.test(channel)) throw new Error(`Invalid channel: ${channel}`);

	let schemaPromise: Promise<void> | null = null;
	let readyPromise: Promise<void> | null = null;
	let onEventCallback: ((event: EphemeralBroadcast) => void) | null = null;
	const pollMs = typeof config.bus === "object" ? Math.max(10, config.bus.poll) : null;
	const busTable = `${table}_bus`;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	/** Highest bus id this subscriber has delivered (or skipped, at start). */
	let busCursor: string | null = null;

	function ensureSchema(): Promise<void> {
		schemaPromise ??= (async () => {
			await client.query(`
				CREATE TABLE IF NOT EXISTS ${table} (
					room TEXT NOT NULL,
					key TEXT NOT NULL,
					client_id TEXT NOT NULL,
					user_id TEXT NOT NULL,
					data JSONB NOT NULL,
					updated_at BIGINT NOT NULL,
					ttl_ms BIGINT,
					expires_at BIGINT NOT NULL,
					PRIMARY KEY (room, key, client_id)
				)
			`);
			// removeClient and the sweep both look rows up by something other
			// than the primary key; without these they scan the whole table.
			await client.query(`CREATE INDEX IF NOT EXISTS ${table}_client ON ${table} (client_id)`);
			await client.query(`CREATE INDEX IF NOT EXISTS ${table}_expires ON ${table} (expires_at)`);
			if (pollMs !== null) {
				await client.query(`
					CREATE TABLE IF NOT EXISTS ${busTable} (
						id BIGSERIAL PRIMARY KEY,
						payload JSONB NOT NULL,
						created_at BIGINT NOT NULL
					)
				`);
			}
		})().catch((err) => {
			schemaPromise = null;
			throw err;
		});
		return schemaPromise;
	}

	function toState(row: Row): EphemeralState {
		const state: EphemeralState = {
			clientId: row.client_id,
			userId: row.user_id,
			key: row.key,
			data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
			updatedAt: Number(row.updated_at),
		};
		if (row.ttl_ms != null) state.ttlMs = Number(row.ttl_ms);
		return state;
	}

	function deliver(event: EphemeralBroadcast): void {
		try {
			onEventCallback?.(event);
		} catch {
			// One bad delivery must not stop the bus.
		}
	}

	/** One poll of the bus table: everything after the cursor, in order. */
	async function pollBus(): Promise<void> {
		if (busCursor === null) {
			// Start at the head: a subscriber delivers what is published after it
			// joined, like LISTEN, rather than replaying the retention window.
			const { rows } = await client.query<{ id: string | null }>(
				`SELECT max(id)::text AS id FROM ${busTable}`,
			);
			busCursor = rows[0]?.id ?? "0";
			return;
		}
		const { rows } = await client.query<{ id: string; payload: EphemeralBroadcast | string }>(
			`SELECT id::text AS id, payload FROM ${busTable} WHERE id > $1 ORDER BY id LIMIT 1000`,
			[busCursor],
		);
		for (const row of rows) {
			busCursor = row.id;
			deliver(typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload);
		}
	}

	/** Resolves once the bus is live (LISTEN issued, or the poll cursor primed). Idempotent. */
	async function ready(): Promise<void> {
		if (pollMs !== null) {
			readyPromise ??= (async () => {
				await ensureSchema();
				await pollBus();
				let busy = false;
				pollTimer = setInterval(() => {
					if (busy || !onEventCallback) return;
					busy = true;
					pollBus()
						.catch((err) => console.error("[reflectdb] ephemeral bus poll failed:", err))
						.finally(() => {
							busy = false;
						});
				}, pollMs);
				// A poller must not keep a process (or a test runner) alive.
				(pollTimer as { unref?: () => void }).unref?.();
			})().catch((err) => {
				// Not cached: the next ready() (the handler retries) tries again.
				readyPromise = null;
				throw err;
			});
			return readyPromise;
		}
		const listener = config.listener;
		if (!listener) return;
		readyPromise ??= (async () => {
			await listener.listen(channel, (payload) => {
				if (!onEventCallback) return;
				let event: EphemeralBroadcast;
				try {
					event = JSON.parse(payload) as EphemeralBroadcast;
				} catch {
					return; // A malformed frame must not take the listener down.
				}
				deliver(event);
			});
		})().catch((err) => {
			readyPromise = null;
			throw err;
		});
		return readyPromise;
	}

	return {
		ready,
		ensureSchema,

		async set(room, key, clientId, userId, data, ttlMs): Promise<boolean> {
			await ensureSchema();
			const now = Date.now();
			const expiresAt = now + (ttlMs ?? maxAgeMs);
			// One statement, so the capacity check and the write cannot be split
			// by a concurrent writer: an existing identity always updates, a new
			// one inserts only while the live count is under the ceiling.
			const { rows } = await client.query(
				`INSERT INTO ${table} (room, key, client_id, user_id, data, updated_at, ttl_ms, expires_at)
				 SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8
				 WHERE EXISTS (SELECT 1 FROM ${table} WHERE room = $1 AND key = $2 AND client_id = $3)
				    OR (SELECT count(*) FROM ${table} WHERE expires_at > $6) < $9
				 ON CONFLICT (room, key, client_id) DO UPDATE SET
				   user_id = EXCLUDED.user_id, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at,
				   ttl_ms = EXCLUDED.ttl_ms, expires_at = EXCLUDED.expires_at
				 RETURNING 1 AS ok`,
				[
					room,
					key,
					clientId,
					userId,
					JSON.stringify(data),
					now,
					ttlMs ?? null,
					expiresAt,
					maxEntries,
				],
			);
			return rows.length > 0;
		},

		async get(room, key): Promise<Record<string, EphemeralState>> {
			await ensureSchema();
			const { rows } = await client.query<Row>(
				`SELECT * FROM ${table} WHERE room = $1 AND key = $2 AND expires_at > $3`,
				[room, key, Date.now()],
			);
			const out: Record<string, EphemeralState> = {};
			for (const row of rows) out[row.client_id] = toState(row);
			return out;
		},

		async getRoom(room): Promise<Record<string, Record<string, EphemeralState>>> {
			await ensureSchema();
			const { rows } = await client.query<Row>(
				`SELECT * FROM ${table} WHERE room = $1 AND expires_at > $2`,
				[room, Date.now()],
			);
			const out: Record<string, Record<string, EphemeralState>> = {};
			for (const row of rows) {
				const byClient = (out[row.key] ??= {});
				byClient[row.client_id] = toState(row);
			}
			return out;
		},

		async remove(room, key, clientId): Promise<void> {
			await ensureSchema();
			await client.query(`DELETE FROM ${table} WHERE room = $1 AND key = $2 AND client_id = $3`, [
				room,
				key,
				clientId,
			]);
		},

		async removeClient(clientId): Promise<void> {
			await ensureSchema();
			await client.query(`DELETE FROM ${table} WHERE client_id = $1`, [clientId]);
		},

		async cleanupExpired(): Promise<void> {
			await ensureSchema();
			await client.query(
				`DELETE FROM ${table} WHERE ctid IN (
					SELECT ctid FROM ${table} WHERE expires_at <= $1 LIMIT ${SWEEP_BATCH}
				)`,
				[Date.now()],
			);
			if (pollMs !== null) {
				await client.query(
					`DELETE FROM ${busTable} WHERE ctid IN (
						SELECT ctid FROM ${busTable} WHERE created_at <= $1 LIMIT ${SWEEP_BATCH}
					)`,
					[Date.now() - BUS_RETENTION_MS],
				);
			}
		},

		async size(): Promise<number> {
			await ensureSchema();
			const { rows } = await client.query<{ n: string | number }>(
				`SELECT count(*) AS n FROM ${table} WHERE expires_at > $1`,
				[Date.now()],
			);
			return Number(rows[0]?.n ?? 0);
		},

		async destroy(): Promise<void> {
			// Shared state outlives this process — dropping it would wipe presence
			// for every other instance. Only the local listener goes; the LISTEN
			// connection belongs to the caller, who closes it.
			onEventCallback = null;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = null;
			readyPromise = null;
			busCursor = null;
		},

		async publish(event): Promise<void> {
			const payload = JSON.stringify(event);
			if (pollMs !== null) {
				await ensureSchema();
				await client.query(`INSERT INTO ${busTable} (payload, created_at) VALUES ($1::jsonb, $2)`, [
					payload,
					Date.now(),
				]);
				return;
			}
			if (new TextEncoder().encode(payload).byteLength > MAX_NOTIFY_BYTES) {
				throw new Error(
					`ephemeral event is ${payload.length} bytes; Postgres NOTIFY carries at most ${MAX_NOTIFY_BYTES}`,
				);
			}
			await client.query(`SELECT pg_notify($1, $2)`, [channel, payload]);
		},

		async subscribe(onEvent): Promise<void> {
			onEventCallback = onEvent;
			await ready();
		},
	};
}
