import { createRequire } from "node:module";
import type { StorageAdapter, OpLogEntry } from "../handler.ts";
import type { ExistingRow } from "../conflict.ts";

/**
 * Structural stand-in for `bun:sqlite`'s `Database`, covering only the surface
 * this adapter uses. A real `bun:sqlite` Database satisfies it structurally.
 *
 * Deliberately NOT `import("bun:sqlite").Database`: that type reference survives
 * into the emitted `dist/server/index.d.ts`, and the specifier does not resolve
 * for consumers who type-check under Node without `@types/bun` — every such
 * consumer gets "Cannot find module 'bun:sqlite'" from a declaration file they
 * never asked for. `bun run verify:exports` guards the regression.
 */
type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/**
 * Bind parameters stay `SqlValue[]` rather than a per-statement tuple: bun's own
 * `Statement` takes a union of tuple shapes, and a generic tuple here makes a
 * real `Database` fail to satisfy `BunDatabase` — which would break every Bun
 * caller passing `{ db }`. Row types, the part worth keeping, are still exact.
 */
export interface BunStatement<Row> {
	all(...params: SqlValue[]): Row[];
	get(...params: SqlValue[]): Row | null;
	run(...params: SqlValue[]): { changes: number };
	/**
	 * Releases the statement's sqlite handle. Optional so a hand-rolled stand-in
	 * need not implement it; `bun:sqlite` always does.
	 */
	finalize?(): void;
}

export interface BunDatabase {
	// Rest-of-arrays, not an optional array: bun's own `run` is
	// `(sql, ...bindings: ParamsType[])`, and an optional parameter here makes a
	// real `Database` unassignable to this interface.
	run(sql: string, ...params: SqlValue[][]): { changes: number };
	prepare<Row = unknown>(sql: string): BunStatement<Row>;
	transaction<T>(fn: () => T): () => T;
	close(): void;
}

type Database = BunDatabase;

// Compile-time proof that a real `bun:sqlite` Database still satisfies the
// structural stand-in — the whole point of `db?: Database` is that Bun callers
// can hand us one. `bun run type-check` fails here if the shapes drift.
// Not exported, so `bun:sqlite` stays out of the emitted declarations;
// `bun run verify:exports` fails if it ever leaks back in.
type Assert<T extends true> = T;
type _BunDatabaseIsSatisfied = Assert<
	import("bun:sqlite").Database extends BunDatabase ? true : false
>;

// `bun:sqlite` exists only under Bun, and `reflectdb/server` re-exports this
// module. A top-level import therefore makes the entire server entry point
// unloadable on Node — including for apps that only use
// `createPostgresStorage`. Resolve it lazily, on the SQLite path alone.
const requireFn = createRequire(import.meta.url);

function loadDatabase(): new (path?: string) => BunDatabase {
	try {
		return (requireFn("bun:sqlite") as { Database: new (path?: string) => BunDatabase }).Database;
	} catch {
		throw new Error(
			"createSqliteStorage requires the Bun runtime (bun:sqlite is unavailable). Use createPostgresStorage on Node.",
		);
	}
}

/**
 * Runs a one-off statement and releases its handle before returning. Statements
 * built per call — the ones with a variable number of placeholders — would
 * otherwise stay live until the GC collects them, and `db.close()`
 * (`sqlite3_close_v2`) leaves the file open while any statement is outstanding.
 */
function withStatement<Row, T>(
	statement: BunStatement<Row>,
	use: (statement: BunStatement<Row>) => T,
): T {
	try {
		return use(statement);
	} finally {
		statement.finalize?.();
	}
}

const OP_ID_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SqliteStorageConfig {
	/** Path to SQLite database file, or ":memory:" for in-memory */
	path?: string;
	/** Existing Database instance to use instead of creating one */
	db?: Database;
}

export function createSqliteStorage(
	config: SqliteStorageConfig = {},
): StorageAdapter & { close(): void } {
	const db = config.db ?? new (loadDatabase())(config.path ?? ":memory:");

	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA synchronous = NORMAL");

	db.run(`
		CREATE TABLE IF NOT EXISTS _reflectdb_rows (
			tbl TEXT NOT NULL,
			row_id TEXT NOT NULL,
			data TEXT NOT NULL,
			col_clocks TEXT NOT NULL,
			hlc TEXT NOT NULL,
			PRIMARY KEY (tbl, row_id)
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS _reflectdb_oplog (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			tbl TEXT NOT NULL,
			op TEXT NOT NULL,
			row_id TEXT NOT NULL,
			payload TEXT,
			hlc TEXT NOT NULL,
			col_clocks TEXT NOT NULL
		)
	`);

	// Compaction scans by hlc alone.
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_oplog_hlc ON _reflectdb_oplog (hlc)
	`);

	// Resume asks "which of these tables changed since HLC X" — a composite
	// (tbl, hlc) index answers it from the index alone.
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_oplog_tbl_hlc ON _reflectdb_oplog (tbl, hlc)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS _reflectdb_processed_ops (
			op_id TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL
		)
	`);

	// The retention sweep filters on created_at; without this it scans every
	// op id ever processed.
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_processed_ops_created_at ON _reflectdb_processed_ops (created_at)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS _reflectdb_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);

	const getRowStmt = db.prepare<{ data: string; col_clocks: string; hlc: string }>(
		"SELECT data, col_clocks, hlc FROM _reflectdb_rows WHERE tbl = ? AND row_id = ?",
	);

	const putRowStmt = db.prepare(
		"INSERT OR REPLACE INTO _reflectdb_rows (tbl, row_id, data, col_clocks, hlc) VALUES (?, ?, ?, ?, ?)",
	);

	const deleteRowStmt = db.prepare("DELETE FROM _reflectdb_rows WHERE tbl = ? AND row_id = ?");

	const getRowsStmt = db.prepare<{ row_id: string; data: string; col_clocks: string }>(
		"SELECT row_id, data, col_clocks FROM _reflectdb_rows WHERE tbl = ?",
	);

	const appendOpStmt = db.prepare(
		"INSERT INTO _reflectdb_oplog (tbl, op, row_id, payload, hlc, col_clocks) VALUES (?, ?, ?, ?, ?, ?)",
	);

	const deleteOpsStmt = db.prepare("DELETE FROM _reflectdb_oplog WHERE hlc < ?");

	const reserveOpStmt = db.prepare(
		"INSERT OR IGNORE INTO _reflectdb_processed_ops (op_id, created_at) VALUES (?, ?)",
	);

	const cleanupOpsStmt = db.prepare("DELETE FROM _reflectdb_processed_ops WHERE created_at < ?");

	const getMetaStmt = db.prepare<{ value: string }>(
		"SELECT value FROM _reflectdb_meta WHERE key = ?",
	);

	const setMetaStmt = db.prepare(
		"INSERT OR REPLACE INTO _reflectdb_meta (key, value) VALUES (?, ?)",
	);

	// `db.close()` is `sqlite3_close_v2`: while any statement is still live the
	// connection is only marked for closing, and the file stays open until the GC
	// finalizes them. Windows then refuses to delete the database file. Keeping
	// the long-lived statements here lets `close()` release them deterministically.
	const persistentStatements: { finalize?(): void }[] = [
		getRowStmt,
		putRowStmt,
		deleteRowStmt,
		getRowsStmt,
		appendOpStmt,
		deleteOpsStmt,
		reserveOpStmt,
		cleanupOpsStmt,
		getMetaStmt,
		setMetaStmt,
	];

	return {
		async getRow(table: string, rowId: string): Promise<ExistingRow> {
			const result = getRowStmt.get(table, rowId);
			if (!result) {
				return { row: null, rowHlc: null, colClocks: {} };
			}
			return {
				row: JSON.parse(result.data),
				rowHlc: result.hlc,
				colClocks: JSON.parse(result.col_clocks),
			};
		},

		async getRowsByIds(table: string, rowIds: string[]): Promise<Record<string, ExistingRow>> {
			if (rowIds.length === 0) return {};
			const placeholders = rowIds.map(() => "?").join(", ");
			const results = withStatement(
				db.prepare<{ row_id: string; data: string; col_clocks: string; hlc: string }>(
					`SELECT row_id, data, col_clocks, hlc FROM _reflectdb_rows WHERE tbl = ? AND row_id IN (${placeholders})`,
				),
				(stmt) => stmt.all(table, ...rowIds),
			);
			const out: Record<string, ExistingRow> = {};
			for (const r of results) {
				out[r.row_id] = {
					row: JSON.parse(r.data),
					rowHlc: r.hlc,
					colClocks: JSON.parse(r.col_clocks),
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
			if (row === null) {
				deleteRowStmt.run(table, rowId);
			} else {
				putRowStmt.run(table, rowId, JSON.stringify(row), JSON.stringify(colClocks), hlc);
			}
		},

		async getRows(table: string): Promise<{
			rows: Record<string, unknown>[];
			colClocks: Record<string, Record<string, string>>;
		}> {
			const results = getRowsStmt.all(table);
			const rows: Record<string, unknown>[] = [];
			const colClocks: Record<string, Record<string, string>> = {};

			for (const result of results) {
				const data = JSON.parse(result.data);
				rows.push(data);
				colClocks[result.row_id] = JSON.parse(result.col_clocks);
			}

			return { rows, colClocks };
		},

		async appendOp(entry: OpLogEntry): Promise<void> {
			appendOpStmt.run(
				entry.table,
				entry.op,
				entry.rowId,
				entry.payload ? JSON.stringify(entry.payload) : null,
				entry.hlc,
				JSON.stringify(entry.colClocks),
			);
		},

		async applyOp(
			table: string,
			rowId: string,
			row: Record<string, unknown> | null,
			colClocks: Record<string, string>,
			hlc: string,
			opType: string,
			payload: Record<string, unknown> | null,
		): Promise<void> {
			const tx = db.transaction(() => {
				if (row === null) {
					deleteRowStmt.run(table, rowId);
				} else {
					putRowStmt.run(table, rowId, JSON.stringify(row), JSON.stringify(colClocks), hlc);
				}
				appendOpStmt.run(
					table,
					opType,
					rowId,
					payload ? JSON.stringify(payload) : null,
					hlc,
					JSON.stringify(colClocks),
				);
			});
			tx();
		},

		async getOpsSince(since: string, tables: string[]): Promise<OpLogEntry[]> {
			if (tables.length === 0) return [];

			const placeholders = tables.map(() => "?").join(", ");
			const results = withStatement(
				db.prepare<{
					tbl: string;
					op: string;
					row_id: string;
					payload: string | null;
					hlc: string;
					col_clocks: string;
				}>(
					`SELECT tbl, op, row_id, payload, hlc, col_clocks FROM _reflectdb_oplog WHERE hlc > ? AND tbl IN (${placeholders}) ORDER BY hlc ASC`,
				),
				(stmt) => stmt.all(since, ...tables),
			);
			return results.map((r) => ({
				table: r.tbl,
				op: r.op,
				rowId: r.row_id,
				payload: r.payload ? JSON.parse(r.payload) : null,
				hlc: r.hlc,
				colClocks: JSON.parse(r.col_clocks),
			}));
		},

		async getChangedTablesSince(since: string, tables: string[]): Promise<string[]> {
			if (tables.length === 0) return [];
			const placeholders = tables.map(() => "?").join(", ");
			// DISTINCT, not the op rows themselves: resume only needs the set of
			// affected tables, and a long-offline client's op range is unbounded.
			return withStatement(
				db.prepare<{ tbl: string }>(
					`SELECT DISTINCT tbl FROM _reflectdb_oplog WHERE hlc > ? AND tbl IN (${placeholders})`,
				),
				(stmt) => stmt.all(since, ...tables).map((r) => r.tbl),
			);
		},

		async getOplogHead(tables: string[]): Promise<string | null> {
			if (tables.length === 0) return null;
			const placeholders = tables.map(() => "?").join(", ");
			return withStatement(
				db.prepare<{ head: string | null }>(
					`SELECT MAX(hlc) AS head FROM _reflectdb_oplog WHERE tbl IN (${placeholders})`,
				),
				(stmt) => stmt.get(...tables)?.head ?? null,
			);
		},

		async deleteOpsBefore(hlc: string): Promise<number> {
			const result = deleteOpsStmt.run(hlc);
			return result.changes;
		},

		async reserveOp(opId: string): Promise<boolean> {
			const now = Date.now();
			const result = reserveOpStmt.run(opId, now);
			if (Math.random() < 0.01) {
				cleanupOpsStmt.run(now - OP_ID_RETENTION_MS);
			}
			// INSERT OR IGNORE returns changes=1 on insert, 0 on conflict.
			return result.changes > 0;
		},

		async reserveOps(opIds: string[]): Promise<string[]> {
			if (opIds.length === 0) return [];
			const now = Date.now();
			const fresh: string[] = [];
			// One transaction for the batch — SQLite's per-statement commit is
			// what makes 100 sequential reserves expensive, not the inserts.
			const tx = db.transaction(() => {
				for (const opId of opIds) {
					if (reserveOpStmt.run(opId, now).changes > 0) fresh.push(opId);
				}
			});
			tx();
			if (Math.random() < 0.01) {
				cleanupOpsStmt.run(now - OP_ID_RETENTION_MS);
			}
			return fresh;
		},

		async getMeta(key: string): Promise<string | null> {
			const result = getMetaStmt.get(key);
			return result?.value ?? null;
		},

		async setMeta(key: string, value: string): Promise<void> {
			setMetaStmt.run(key, value);
		},

		// Cross-instance lock via _reflectdb_meta sentinel row. Stale locks (60s TTL)
		// are reclaimed atomically so a crashed holder cannot wedge compaction.
		async tryLock(key: string): Promise<boolean> {
			const lockKey = `lock:${key}`;
			const now = Date.now();
			const ttlMs = 60_000;
			const expiry = now - ttlMs;
			const result = db.run(
				`INSERT INTO _reflectdb_meta (key, value) VALUES (?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value
				 WHERE CAST(_reflectdb_meta.value AS INTEGER) < ?`,
				[lockKey, String(now), String(expiry)],
			);
			return result.changes > 0;
		},

		async unlock(key: string): Promise<void> {
			db.run("DELETE FROM _reflectdb_meta WHERE key = ?", [`lock:${key}`]);
		},

		close(): void {
			for (const statement of persistentStatements) {
				statement.finalize?.();
			}
			db.close();
		},
	};
}
