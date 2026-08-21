/**
 * Shared presence state.
 *
 * The service keeps nothing in the process that two visitors both depend on:
 * on Vercel the stream that reads a room and the POST that writes it land on
 * different instances routinely, so anything held in a local `Map` would be
 * invisible to half the room. Every read and write goes here instead.
 *
 * Entries are disposable by construction — every one carries an expiry, and a
 * client republishes within one TTL — so the backing table needs no durability
 * guarantees, no backups, and no migration story beyond `CREATE TABLE IF NOT
 * EXISTS`.
 */

export interface StoredEntry {
	clientId: string;
	channel: string;
	data: Record<string, unknown>;
	identity?: Record<string, unknown>;
	/** Epoch ms of the last write, from the store's clock. Drives diffing. */
	updatedAt: number;
}

/**
 * Why a write did not land.
 *
 * `rate_limited` falls out of the write itself rather than a separate counter:
 * a row that was updated more recently than the project's minimum interval
 * refuses the update. That makes the limit correct across the fleet for free,
 * where a per-instance token bucket would let a client multiply its allowance
 * by the number of instances it happened to reach.
 */
export type WriteOutcome = "ok" | "rate_limited" | "room_full";

export interface WriteRequest {
	projectId: string;
	room: string;
	channel: string;
	clientId: string;
	data: Record<string, unknown>;
	identity?: Record<string, unknown>;
	ttlMs: number;
	maxEntriesPerRoom: number;
	/** Shortest gap allowed between two writes to the same entry. */
	minIntervalMs: number;
}

export interface PresenceStore {
	write(request: WriteRequest): Promise<WriteOutcome>;
	/** Every live entry in one room, across all channels. */
	room(projectId: string, room: string): Promise<StoredEntry[]>;
	/** Drop one channel a client holds, or everything it holds when omitted. */
	remove(projectId: string, room: string, clientId: string, channel?: string): Promise<void>;
	/** Distinct clients with live state in a project, for the connection cap. */
	countClients(projectId: string): Promise<number>;
	/** Whether one client already holds live state anywhere in a project. */
	hasClient(projectId: string, clientId: string): Promise<boolean>;
	/** Delete expired rows. Returns how many went. */
	sweep(limit?: number): Promise<number>;
	close(): Promise<void>;
}

/** Rows removed per sweep. Bounds the work any one request can be charged for. */
export const SWEEP_BATCH = 500;

// ── Postgres ────────────────────────────────────────────────────────────────

/**
 * The slice of `pg.Pool` this module uses.
 *
 * Narrow on purpose: the service takes no dependency on a specific driver, and
 * a caller with a Neon or postgres.js client wires it in with a shim rather
 * than a fork.
 */
export interface SqlClient {
	query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const PRESENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS presence_entry (
  project_id text   NOT NULL,
  room       text   NOT NULL,
  channel    text   NOT NULL,
  client_id  text   NOT NULL,
  data       jsonb  NOT NULL,
  identity   jsonb,
  updated_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (project_id, room, channel, client_id)
);
CREATE INDEX IF NOT EXISTS presence_entry_room_idx
  ON presence_entry (project_id, room, expires_at);
CREATE INDEX IF NOT EXISTS presence_entry_expiry_idx
  ON presence_entry (expires_at);
`;

/**
 * Epoch milliseconds from the database rather than the caller.
 *
 * Every instance reading or writing a room is a different machine, so a
 * timestamp taken locally makes TTLs and the rate-limit window depend on how
 * closely those clocks agree. Taking the clock from the one process they all
 * talk to removes the question.
 */
const NOW_MS = "(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint";

/**
 * One statement does the capacity check, the rate-limit check and the upsert.
 *
 * Splitting them would need a transaction to mean anything — presence is the
 * highest-frequency write in the protocol, and two clients racing for the last
 * slot in a room would otherwise both read "there is room" and both insert.
 */
const WRITE_SQL = `
WITH clock AS (SELECT ${NOW_MS} AS t),
live AS (
  SELECT count(*)::int AS n
    FROM presence_entry, clock
   WHERE project_id = $1 AND room = $2 AND expires_at > clock.t
),
existing AS (
  SELECT 1 AS hit
    FROM presence_entry
   WHERE project_id = $1 AND room = $2 AND channel = $3 AND client_id = $4
),
written AS (
  INSERT INTO presence_entry AS pe
    (project_id, room, channel, client_id, data, identity, updated_at, expires_at)
  SELECT $1, $2, $3, $4, $5::jsonb, $6::jsonb, clock.t, clock.t + $8::bigint
    FROM clock
   WHERE (SELECT n FROM live) < $7::int OR EXISTS (SELECT 1 FROM existing)
  ON CONFLICT (project_id, room, channel, client_id) DO UPDATE
     SET data       = EXCLUDED.data,
         identity   = EXCLUDED.identity,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at
   WHERE pe.updated_at <= EXCLUDED.updated_at - $9::bigint
  RETURNING 1
)
SELECT (SELECT count(*)::int FROM written) AS written,
       (SELECT count(*)::int FROM existing) AS existed
`;

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export interface PostgresStoreConfig {
	sql: SqlClient;
	/** Run `CREATE TABLE IF NOT EXISTS` before the first query. Default true. */
	migrate?: boolean;
	onClose?: () => Promise<void> | void;
}

export function createPostgresStore(config: PostgresStoreConfig): PresenceStore {
	const sql = config.sql;
	// One migration per process, not per request: every handler awaits the same
	// promise, and a cold instance pays for it once.
	let migration: Promise<void> | null = null;

	async function ready(): Promise<void> {
		if (config.migrate === false) return;
		migration ??= sql.query(PRESENCE_SCHEMA_SQL).then(() => undefined);
		await migration;
	}

	return {
		async write(request: WriteRequest): Promise<WriteOutcome> {
			await ready();
			const { rows } = await sql.query(WRITE_SQL, [
				request.projectId,
				request.room,
				request.channel,
				request.clientId,
				JSON.stringify(request.data),
				request.identity ? JSON.stringify(request.identity) : null,
				request.maxEntriesPerRoom,
				Math.round(request.ttlMs),
				Math.round(request.minIntervalMs),
			]);
			const row = rows[0] ?? {};
			if (Number(row.written) > 0) return "ok";
			// The upsert was refused. Which check refused it is knowable from
			// whether the row was already there: an existing row can only have
			// been turned away by the interval guard.
			return Number(row.existed) > 0 ? "rate_limited" : "room_full";
		},

		async room(projectId: string, room: string): Promise<StoredEntry[]> {
			await ready();
			const { rows } = await sql.query(
				`SELECT channel, client_id, data, identity, updated_at
				   FROM presence_entry
				  WHERE project_id = $1 AND room = $2 AND expires_at > ${NOW_MS}
				  ORDER BY channel, client_id`,
				[projectId, room],
			);
			return rows.map((row) => ({
				clientId: String(row.client_id),
				channel: String(row.channel),
				data: asObject(row.data),
				identity: row.identity == null ? undefined : asObject(row.identity),
				updatedAt: Number(row.updated_at),
			}));
		},

		async remove(
			projectId: string,
			room: string,
			clientId: string,
			channel?: string,
		): Promise<void> {
			await ready();
			await sql.query(
				`DELETE FROM presence_entry
				  WHERE project_id = $1 AND room = $2 AND client_id = $3
				    AND ($4::text IS NULL OR channel = $4)`,
				[projectId, room, clientId, channel ?? null],
			);
		},

		async countClients(projectId: string): Promise<number> {
			await ready();
			const { rows } = await sql.query(
				`SELECT count(DISTINCT client_id)::int AS n
				   FROM presence_entry
				  WHERE project_id = $1 AND expires_at > ${NOW_MS}`,
				[projectId],
			);
			return Number(rows[0]?.n ?? 0);
		},

		async hasClient(projectId: string, clientId: string): Promise<boolean> {
			await ready();
			const { rows } = await sql.query(
				`SELECT 1 FROM presence_entry
				  WHERE project_id = $1 AND client_id = $2 AND expires_at > ${NOW_MS}
				  LIMIT 1`,
				[projectId, clientId],
			);
			return rows.length > 0;
		},

		async sweep(limit: number = SWEEP_BATCH): Promise<number> {
			await ready();
			// Delete by ctid off a bounded subquery so one sweep cannot take a
			// table-wide lock on a backlog.
			const { rows } = await sql.query(
				`DELETE FROM presence_entry
				  WHERE ctid IN (
				    SELECT ctid FROM presence_entry WHERE expires_at <= ${NOW_MS} LIMIT $1
				  )
				  RETURNING 1`,
				[limit],
			);
			return rows.length;
		},

		async close(): Promise<void> {
			await config.onClose?.();
		},
	};
}

// ── Memory ──────────────────────────────────────────────────────────────────

interface MemoryRow extends StoredEntry {
	projectId: string;
	room: string;
	expiresAt: number;
}

/**
 * Single-process store, for tests and `bun services/presence/dev.ts`.
 *
 * Correct for one process and invisible across a fleet — two clients on
 * different instances would never see each other. Never deploy on it.
 */
export function createMemoryStore(now: () => number = Date.now): PresenceStore {
	const rows = new Map<string, MemoryRow>();
	const keyOf = (p: string, r: string, c: string, id: string) =>
		`${p}\u0000${r}\u0000${c}\u0000${id}`;
	const live = (row: MemoryRow, t: number) => row.expiresAt > t;

	return {
		async write(request: WriteRequest): Promise<WriteOutcome> {
			const t = now();
			const key = keyOf(request.projectId, request.room, request.channel, request.clientId);
			const existing = rows.get(key);

			if (existing && existing.updatedAt > t - request.minIntervalMs) return "rate_limited";
			if (!existing) {
				let count = 0;
				for (const row of rows.values()) {
					if (row.projectId === request.projectId && row.room === request.room && live(row, t)) {
						count++;
					}
				}
				if (count >= request.maxEntriesPerRoom) return "room_full";
			}

			rows.set(key, {
				projectId: request.projectId,
				room: request.room,
				channel: request.channel,
				clientId: request.clientId,
				data: request.data,
				identity: request.identity,
				updatedAt: t,
				expiresAt: t + request.ttlMs,
			});
			return "ok";
		},

		async room(projectId: string, room: string): Promise<StoredEntry[]> {
			const t = now();
			const out: StoredEntry[] = [];
			for (const row of rows.values()) {
				if (row.projectId !== projectId || row.room !== room || !live(row, t)) continue;
				out.push({
					clientId: row.clientId,
					channel: row.channel,
					data: row.data,
					identity: row.identity,
					updatedAt: row.updatedAt,
				});
			}
			out.sort(
				(a, b) => a.channel.localeCompare(b.channel) || a.clientId.localeCompare(b.clientId),
			);
			return out;
		},

		async remove(
			projectId: string,
			room: string,
			clientId: string,
			channel?: string,
		): Promise<void> {
			for (const [key, row] of rows) {
				if (row.projectId !== projectId || row.room !== room || row.clientId !== clientId) {
					continue;
				}
				if (channel !== undefined && row.channel !== channel) continue;
				rows.delete(key);
			}
		},

		async countClients(projectId: string): Promise<number> {
			const t = now();
			const clients = new Set<string>();
			for (const row of rows.values()) {
				if (row.projectId === projectId && live(row, t)) clients.add(row.clientId);
			}
			return clients.size;
		},

		async hasClient(projectId: string, clientId: string): Promise<boolean> {
			const t = now();
			for (const row of rows.values()) {
				if (row.projectId === projectId && row.clientId === clientId && live(row, t)) return true;
			}
			return false;
		},

		async sweep(limit: number = SWEEP_BATCH): Promise<number> {
			const t = now();
			let removed = 0;
			for (const [key, row] of rows) {
				if (removed >= limit) break;
				if (live(row, t)) continue;
				rows.delete(key);
				removed++;
			}
			return removed;
		},

		async close(): Promise<void> {
			rows.clear();
		},
	};
}
