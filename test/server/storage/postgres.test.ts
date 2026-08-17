import { runStorageAdapterSuite } from "./storage-adapter-suite.ts";
import { createPostgresStorage } from "../../../src/server/storage/postgres.ts";
import type { PostgresClient } from "../../../src/server/storage/postgres.ts";

/**
 * In-memory Postgres client mock that implements the PostgresClient interface.
 * Simulates parameterized queries against in-memory tables for testing
 * the Postgres StorageAdapter without requiring a real database.
 */
function createMockPostgresClient(): PostgresClient {
	const tables = new Map<string, Map<string, Record<string, unknown>>>();

	function getTable(name: string): Map<string, Record<string, unknown>> {
		let t = tables.get(name);
		if (!t) {
			t = new Map();
			tables.set(name, t);
		}
		return t;
	}

	let oplogSeq = 0;

	return {
		async query<T extends Record<string, unknown>>(
			text: string,
			values: unknown[] = [],
		): Promise<{ rows: T[] }> {
			const sql = text.replace(/\s+/g, " ").trim();

			// ── CREATE TABLE / CREATE INDEX ────────────────
			if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX")) {
				return { rows: [] as T[] };
			}

			// ── _rows DELETE ───────────────────────────────
			if (sql.startsWith("DELETE FROM _reflectdb_rows")) {
				const t = getTable("_rows");
				t.delete(`${values[0]}:${values[1]}`);
				return { rows: [] as T[] };
			}

			// ── _rows SELECT single ────────────────────────
			if (sql.includes("SELECT") && sql.includes("_reflectdb_rows") && sql.includes("row_id = $2")) {
				const t = getTable("_rows");
				const key = `${values[0]}:${values[1]}`;
				const row = t.get(key);
				return { rows: row ? [row as T] : [] };
			}

			// ── _rows SELECT by id list ────────────────────
			if (
				sql.includes("SELECT") &&
				sql.includes("_reflectdb_rows") &&
				sql.includes("row_id IN (")
			) {
				const t = getTable("_rows");
				const wanted = new Set(values.slice(1) as string[]);
				const rows: Record<string, unknown>[] = [];
				for (const row of t.values()) {
					if (row.tbl === values[0] && wanted.has(row.row_id as string)) rows.push(row);
				}
				return { rows: rows as T[] };
			}

			// ── _rows SELECT all ───────────────────────────
			if (sql.includes("SELECT") && sql.includes("_reflectdb_rows") && sql.includes("tbl = $1") && !sql.includes("row_id = $2")) {
				const t = getTable("_rows");
				const rows: Record<string, unknown>[] = [];
				for (const [key, row] of t) {
					if (key.startsWith(`${values[0]}:`)) {
						rows.push(row);
					}
				}
				return { rows: rows as T[] };
			}

			// ── _rows INSERT/UPSERT ────────────────────────
			if (sql.includes("INTO _reflectdb_rows")) {
				const t = getTable("_rows");
				const key = `${values[0]}:${values[1]}`;
				t.set(key, {
					tbl: values[0],
					row_id: values[1],
					data: JSON.parse(values[2] as string),
					col_clocks: JSON.parse(values[3] as string),
					hlc: values[4],
				});
				return { rows: [] as T[] };
			}

			// ── _oplog INSERT ──────────────────────────────
			if (sql.includes("INTO _reflectdb_oplog")) {
				const t = getTable("_oplog");
				const id = String(++oplogSeq);
				t.set(id, {
					id,
					tbl: values[0],
					op: values[1],
					row_id: values[2],
					payload: values[3] != null ? JSON.parse(values[3] as string) : null,
					hlc: values[4],
					col_clocks: JSON.parse(values[5] as string),
				});
				return { rows: [] as T[] };
			}

			// ── _oplog MAX(hlc) ────────────────────────────
			if (sql.includes("MAX(hlc)") && sql.includes("FROM _reflectdb_oplog")) {
				const t = getTable("_oplog");
				const tableFilter = values as string[];
				let head: string | null = null;
				for (const row of t.values()) {
					if (!tableFilter.includes(row.tbl as string)) continue;
					const hlc = row.hlc as string;
					if (head === null || hlc > head) head = hlc;
				}
				return { rows: [{ head } as unknown as T] };
			}

			// ── _oplog SELECT DISTINCT tbl ─────────────────
			if (sql.includes("SELECT DISTINCT tbl") && sql.includes("FROM _reflectdb_oplog")) {
				const t = getTable("_oplog");
				const since = values[0] as string;
				const tableFilter = values.slice(1) as string[];
				const seen = new Set<string>();
				for (const row of t.values()) {
					if ((row.hlc as string) > since && tableFilter.includes(row.tbl as string)) {
						seen.add(row.tbl as string);
					}
				}
				return { rows: [...seen].map((tbl) => ({ tbl }) as unknown as T) };
			}

			// ── _oplog SELECT ──────────────────────────────
			if (sql.includes("FROM _reflectdb_oplog") && sql.includes("WHERE hlc > $1")) {
				const t = getTable("_oplog");
				const since = values[0] as string;
				const tableFilter = values.slice(1) as string[];
				const rows: Record<string, unknown>[] = [];
				for (const row of t.values()) {
					if ((row.hlc as string) > since && tableFilter.includes(row.tbl as string)) {
						rows.push(row);
					}
				}
				rows.sort((a, b) => (a.hlc as string).localeCompare(b.hlc as string));
				return { rows: rows as T[] };
			}

			// ── _oplog DELETE (via CTE for count) ──────────
			if (sql.includes("DELETE FROM _reflectdb_oplog WHERE hlc < $1")) {
				const t = getTable("_oplog");
				const cutoff = values[0] as string;
				let count = 0;
				for (const [id, row] of t) {
					if ((row.hlc as string) < cutoff) {
						t.delete(id);
						count++;
					}
				}
				return { rows: [{ count: String(count) } as T] };
			}

			// ── _processed_ops SELECT ──────────────────────
			if (sql.includes("FROM _reflectdb_processed_ops WHERE op_id = $1")) {
				const t = getTable("_processed_ops");
				const row = t.get(values[0] as string);
				return { rows: row ? [row as T] : [] };
			}

			// ── pg_try_advisory_lock / pg_advisory_unlock ──
			if (sql.includes("pg_try_advisory_lock")) {
				const t = getTable("_locks");
				const key = String(values[0]);
				if (t.has(key)) {
					return { rows: [{ locked: false } as T] };
				}
				t.set(key, { held: true });
				return { rows: [{ locked: true } as T] };
			}
			if (sql.includes("pg_advisory_unlock")) {
				const t = getTable("_locks");
				t.delete(String(values[0]));
				return { rows: [] as T[] };
			}

			// ── _processed_ops INSERT (single or batch) ────
			if (sql.includes("INTO _reflectdb_processed_ops")) {
				const t = getTable("_processed_ops");
				const inserted: Record<string, unknown>[] = [];
				// Batch form passes (op_id, created_at) pairs.
				for (let i = 0; i < values.length; i += 2) {
					const opId = values[i] as string;
					if (!t.has(opId)) {
						t.set(opId, { op_id: opId, created_at: values[i + 1] });
						inserted.push(sql.includes("RETURNING op_id") ? { op_id: opId } : { inserted: 1 });
					}
				}
				return { rows: inserted as T[] };
			}

			// ── _processed_ops DELETE (bounded retention sweep) ────
			if (sql.includes("DELETE FROM _reflectdb_processed_ops")) {
				const t = getTable("_processed_ops");
				for (const [id, row] of t) {
					if ((row.created_at as number) < (values[0] as number)) {
						t.delete(id);
					}
				}
				return { rows: [] as T[] };
			}

			// ── _meta SELECT ───────────────────────────────
			if (sql.includes("FROM _reflectdb_meta WHERE key = $1")) {
				const t = getTable("_meta");
				const row = t.get(values[0] as string);
				return { rows: row ? [row as T] : [] };
			}

			// ── _meta INSERT/UPSERT ────────────────────────
			if (sql.includes("INTO _reflectdb_meta")) {
				const t = getTable("_meta");
				t.set(values[0] as string, { key: values[0], value: values[1] });
				return { rows: [] as T[] };
			}

			throw new Error(`Unhandled mock SQL: ${sql}`);
		},
	};
}

runStorageAdapterSuite("Postgres (mock client)", () => {
	const client = createMockPostgresClient();
	const storage = createPostgresStorage(client);
	return storage;
});
