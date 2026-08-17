import type { StorageAdapter, OpLogEntry } from "../handler.ts";
import type { ExistingRow } from "../conflict.ts";

const OP_ID_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
/** Rows removed per retention sweep. Keeps the delete's lock footprint small. */
const OP_ID_GC_BATCH = 10_000;

/** Deterministic 64-bit hash of a string, for pg_advisory_lock (bigint key). */
function hashKey(key: string): string {
	// FNV-1a 64-bit
	let hash = 0xcbf29ce484222325n;
	for (let i = 0; i < key.length; i++) {
		hash ^= BigInt(key.charCodeAt(i));
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	// Postgres advisory-lock key is a signed bigint; keep the top bit off.
	return (hash & 0x7fffffffffffffffn).toString();
}

/**
 * Minimal Postgres client interface.
 * Compatible with pg.Pool, pg.Client, @neondatabase/serverless, etc.
 */
export interface PostgresClient {
	query<T extends Record<string, unknown> = Record<string, unknown>>(
		text: string,
		values?: unknown[],
	): Promise<{ rows: T[] }>;
}

export interface PostgresStorageConfig {
	/** Postgres client or pool implementing the query interface */
	client: PostgresClient;
	/** Table name prefix. Default: "_reflectdb" */
	tablePrefix?: string;
}

export function createPostgresStorage(
	clientOrConfig: PostgresClient | PostgresStorageConfig,
): StorageAdapter & { close(): void; ensureSchema(): Promise<void> } {
	const config: PostgresStorageConfig =
		"query" in clientOrConfig ? { client: clientOrConfig } : clientOrConfig;

	const client = config.client;
	const p = config.tablePrefix ?? "_reflectdb";

	let schemaReady = false;
	let schemaPromise: Promise<void> | null = null;

	async function ensureSchema(): Promise<void> {
		if (schemaReady) return;
		if (schemaPromise) return schemaPromise;
		schemaPromise = initSchema();
		await schemaPromise;
		schemaReady = true;
	}

	async function initSchema(): Promise<void> {
		await client.query(`
			CREATE TABLE IF NOT EXISTS ${p}_rows (
				tbl TEXT NOT NULL,
				row_id TEXT NOT NULL,
				data JSONB NOT NULL,
				col_clocks JSONB NOT NULL,
				hlc TEXT NOT NULL,
				PRIMARY KEY (tbl, row_id)
			)
		`);

		await client.query(`
			CREATE TABLE IF NOT EXISTS ${p}_oplog (
				id BIGSERIAL PRIMARY KEY,
				tbl TEXT NOT NULL,
				op TEXT NOT NULL,
				row_id TEXT NOT NULL,
				payload JSONB,
				hlc TEXT NOT NULL,
				col_clocks JSONB NOT NULL
			)
		`);

		// Compaction scans by hlc alone.
		await client.query(
			`CREATE INDEX IF NOT EXISTS idx_${p}_oplog_hlc ON ${p}_oplog (hlc)`,
		);

		// Resume asks "which of these tables changed since HLC X" — a composite
		// (tbl, hlc) index answers it from the index alone. Separate single-column
		// tbl/hlc indexes force the planner to pick one and filter the rest.
		await client.query(
			`CREATE INDEX IF NOT EXISTS idx_${p}_oplog_tbl_hlc ON ${p}_oplog (tbl, hlc)`,
		);

		await client.query(`
			CREATE TABLE IF NOT EXISTS ${p}_processed_ops (
				op_id TEXT PRIMARY KEY,
				created_at BIGINT NOT NULL
			)
		`);

		// The retention sweep filters on created_at; without this it is a full
		// table scan of every op id ever processed.
		await client.query(
			`CREATE INDEX IF NOT EXISTS idx_${p}_processed_ops_created_at ON ${p}_processed_ops (created_at)`,
		);

		await client.query(`
			CREATE TABLE IF NOT EXISTS ${p}_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
	}

	/**
	 * Probabilistic retention sweep for processed op ids.
	 *
	 * Bounded with a LIMIT: an unbounded `DELETE ... WHERE created_at < x` on a
	 * busy deployment locks a large row set inside a request that is otherwise
	 * a single-row insert. Each sweep trims a slice; at a 1% trigger rate the
	 * table still drains far faster than it fills.
	 */
	async function maybeGcProcessedOps(now: number): Promise<void> {
		if (Math.random() >= 0.01) return;
		try {
			await client.query(
				`DELETE FROM ${p}_processed_ops
				 WHERE ctid IN (
					SELECT ctid FROM ${p}_processed_ops WHERE created_at < $1 LIMIT ${OP_ID_GC_BATCH}
				 )`,
				[now - OP_ID_RETENTION_MS],
			);
		} catch (err) {
			// GC is best-effort — never fail a write because retention lagged.
			console.warn("[reflectdb] processed_ops retention sweep failed:", err);
		}
	}

	return {
		async ensureSchema() {
			await ensureSchema();
		},

		async getRow(table: string, rowId: string): Promise<ExistingRow> {
			await ensureSchema();
			const { rows } = await client.query<{
				data: Record<string, unknown>;
				col_clocks: Record<string, string>;
				hlc: string;
			}>(
				`SELECT data, col_clocks, hlc FROM ${p}_rows WHERE tbl = $1 AND row_id = $2`,
				[table, rowId],
			);

			if (rows.length === 0) {
				return { row: null, rowHlc: null, colClocks: {} };
			}

			const r = rows[0]!;
			return {
				row: typeof r.data === "string" ? JSON.parse(r.data) : r.data,
				rowHlc: r.hlc,
				colClocks: typeof r.col_clocks === "string" ? JSON.parse(r.col_clocks) : r.col_clocks,
			};
		},

		async getRowsByIds(
			table: string,
			rowIds: string[],
		): Promise<Record<string, ExistingRow>> {
			await ensureSchema();
			if (rowIds.length === 0) return {};
			const placeholders = rowIds.map((_, i) => `$${i + 2}`).join(", ");
			const { rows } = await client.query<{
				row_id: string;
				data: Record<string, unknown>;
				col_clocks: Record<string, string>;
				hlc: string;
			}>(
				`SELECT row_id, data, col_clocks, hlc FROM ${p}_rows WHERE tbl = $1 AND row_id IN (${placeholders})`,
				[table, ...rowIds],
			);
			const out: Record<string, ExistingRow> = {};
			for (const r of rows) {
				out[r.row_id] = {
					row: typeof r.data === "string" ? JSON.parse(r.data) : r.data,
					rowHlc: r.hlc,
					colClocks:
						typeof r.col_clocks === "string" ? JSON.parse(r.col_clocks) : r.col_clocks,
				};
			}
			return out;
		},

		async putRow(
			table: string,
			rowId: string,
			row: Record<string, unknown> | null,
			colClocks: Record<string, string>,
			hlc: string,
		): Promise<void> {
			await ensureSchema();
			if (row === null) {
				await client.query(
					`DELETE FROM ${p}_rows WHERE tbl = $1 AND row_id = $2`,
					[table, rowId],
				);
			} else {
				await client.query(
					`INSERT INTO ${p}_rows (tbl, row_id, data, col_clocks, hlc)
					 VALUES ($1, $2, $3, $4, $5)
					 ON CONFLICT (tbl, row_id)
					 DO UPDATE SET data = $3, col_clocks = $4, hlc = $5`,
					[table, rowId, JSON.stringify(row), JSON.stringify(colClocks), hlc],
				);
			}
		},

		async getRows(table: string): Promise<{
			rows: Record<string, unknown>[];
			colClocks: Record<string, Record<string, string>>;
		}> {
			await ensureSchema();
			const { rows: results } = await client.query<{
				row_id: string;
				data: Record<string, unknown>;
				col_clocks: Record<string, string>;
			}>(
				`SELECT row_id, data, col_clocks FROM ${p}_rows WHERE tbl = $1`,
				[table],
			);

			const rows: Record<string, unknown>[] = [];
			const colClocks: Record<string, Record<string, string>> = {};

			for (const r of results) {
				rows.push(typeof r.data === "string" ? JSON.parse(r.data) : r.data);
				colClocks[r.row_id] = typeof r.col_clocks === "string" ? JSON.parse(r.col_clocks) : r.col_clocks;
			}

			return { rows, colClocks };
		},

		async appendOp(entry: OpLogEntry): Promise<void> {
			await ensureSchema();
			await client.query(
				`INSERT INTO ${p}_oplog (tbl, op, row_id, payload, hlc, col_clocks)
				 VALUES ($1, $2, $3, $4, $5, $6)`,
				[
					entry.table,
					entry.op,
					entry.rowId,
					entry.payload ? JSON.stringify(entry.payload) : null,
					entry.hlc,
					JSON.stringify(entry.colClocks),
				],
			);
		},

		/**
		 * Atomic putRow + appendOp via a single CTE statement.
		 * Safe on pg.Pool (no multi-statement transaction management needed)
		 * because Postgres treats one query as one atomic operation.
		 */
		async applyOp(
			table: string,
			rowId: string,
			row: Record<string, unknown> | null,
			colClocks: Record<string, string>,
			hlc: string,
			opType: string,
			payload: Record<string, unknown> | null,
		): Promise<void> {
			await ensureSchema();
			const colClocksJson = JSON.stringify(colClocks);
			const payloadJson = payload ? JSON.stringify(payload) : null;

			if (row === null) {
				await client.query(
					`WITH row_delete AS (
						DELETE FROM ${p}_rows WHERE tbl = $1 AND row_id = $2
					)
					INSERT INTO ${p}_oplog (tbl, op, row_id, payload, hlc, col_clocks)
					VALUES ($1, $6, $2, $7, $5, $4)`,
					[table, rowId, null, colClocksJson, hlc, opType, payloadJson],
				);
			} else {
				await client.query(
					`WITH row_upsert AS (
						INSERT INTO ${p}_rows (tbl, row_id, data, col_clocks, hlc)
						VALUES ($1, $2, $3, $4, $5)
						ON CONFLICT (tbl, row_id)
						DO UPDATE SET data = $3, col_clocks = $4, hlc = $5
					)
					INSERT INTO ${p}_oplog (tbl, op, row_id, payload, hlc, col_clocks)
					VALUES ($1, $6, $2, $7, $5, $4)`,
					[table, rowId, JSON.stringify(row), colClocksJson, hlc, opType, payloadJson],
				);
			}
		},

		async tryLock(key: string): Promise<boolean> {
			await ensureSchema();
			const keyHash = hashKey(key);
			const { rows } = await client.query<{ locked: boolean }>(
				`SELECT pg_try_advisory_lock($1) AS locked`,
				[keyHash],
			);
			return rows[0]?.locked === true;
		},

		async unlock(key: string): Promise<void> {
			const keyHash = hashKey(key);
			await client.query(`SELECT pg_advisory_unlock($1)`, [keyHash]);
		},

		async getOpsSince(since: string, tables: string[]): Promise<OpLogEntry[]> {
			await ensureSchema();
			if (tables.length === 0) return [];

			const placeholders = tables.map((_, i) => `$${i + 2}`).join(", ");
			const { rows } = await client.query<{
				tbl: string;
				op: string;
				row_id: string;
				payload: Record<string, unknown> | null;
				hlc: string;
				col_clocks: Record<string, string>;
			}>(
				`SELECT tbl, op, row_id, payload, hlc, col_clocks
				 FROM ${p}_oplog
				 WHERE hlc > $1 AND tbl IN (${placeholders})
				 ORDER BY hlc ASC`,
				[since, ...tables],
			);

			return rows.map((r) => ({
				table: r.tbl,
				op: r.op,
				rowId: r.row_id,
				payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
				hlc: r.hlc,
				colClocks: typeof r.col_clocks === "string" ? JSON.parse(r.col_clocks) : r.col_clocks,
			}));
		},

		async getChangedTablesSince(since: string, tables: string[]): Promise<string[]> {
			await ensureSchema();
			if (tables.length === 0) return [];
			const placeholders = tables.map((_, i) => `$${i + 2}`).join(", ");
			// DISTINCT, not the op rows themselves: resume only needs the set of
			// affected tables, and a long-offline client's op range is unbounded.
			const { rows } = await client.query<{ tbl: string }>(
				`SELECT DISTINCT tbl FROM ${p}_oplog WHERE hlc > $1 AND tbl IN (${placeholders})`,
				[since, ...tables],
			);
			return rows.map((r) => r.tbl);
		},

		async getOplogHead(tables: string[]): Promise<string | null> {
			await ensureSchema();
			if (tables.length === 0) return null;
			const placeholders = tables.map((_, i) => `$${i + 1}`).join(", ");
			const { rows } = await client.query<{ head: string | null }>(
				`SELECT MAX(hlc) AS head FROM ${p}_oplog WHERE tbl IN (${placeholders})`,
				tables,
			);
			return rows[0]?.head ?? null;
		},

		async deleteOpsBefore(hlc: string): Promise<number> {
			await ensureSchema();
			const { rows } = await client.query<{ count: string }>(
				`WITH deleted AS (
					DELETE FROM ${p}_oplog WHERE hlc < $1 RETURNING 1
				) SELECT COUNT(*)::text AS count FROM deleted`,
				[hlc],
			);
			return parseInt(rows[0]?.count ?? "0", 10);
		},

		async reserveOp(opId: string): Promise<boolean> {
			await ensureSchema();
			const now = Date.now();
			const { rows } = await client.query<{ inserted: number }>(
				`INSERT INTO ${p}_processed_ops (op_id, created_at)
				 VALUES ($1, $2)
				 ON CONFLICT (op_id) DO NOTHING
				 RETURNING 1 AS inserted`,
				[opId, now],
			);
			await maybeGcProcessedOps(now);
			return rows.length > 0;
		},

		async reserveOps(opIds: string[]): Promise<string[]> {
			await ensureSchema();
			if (opIds.length === 0) return [];
			const now = Date.now();
			const values = opIds.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
			const params: unknown[] = [];
			for (const id of opIds) params.push(id, now);
			// One round trip for the whole batch instead of one INSERT per op.
			const { rows } = await client.query<{ op_id: string }>(
				`INSERT INTO ${p}_processed_ops (op_id, created_at)
				 VALUES ${values}
				 ON CONFLICT (op_id) DO NOTHING
				 RETURNING op_id`,
				params,
			);
			await maybeGcProcessedOps(now);
			return rows.map((r) => r.op_id);
		},

		async getMeta(key: string): Promise<string | null> {
			await ensureSchema();
			const { rows } = await client.query<{ value: string }>(
				`SELECT value FROM ${p}_meta WHERE key = $1`,
				[key],
			);
			return rows[0]?.value ?? null;
		},

		async setMeta(key: string, value: string): Promise<void> {
			await ensureSchema();
			await client.query(
				`INSERT INTO ${p}_meta (key, value)
				 VALUES ($1, $2)
				 ON CONFLICT (key)
				 DO UPDATE SET value = $2`,
				[key, value],
			);
		},

		close(): void {
			// No-op: caller manages the client/pool lifecycle
		},
	};
}
