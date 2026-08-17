/**
 * Adapter contract for `server.tx({ atomic: true })` — pluggable so non-drizzle
 * data layers (kysely, prisma, raw SQL) can wrap their own BEGIN/COMMIT/ROLLBACK
 * without reflectdb hard-coding a drizzle dependency.
 *
 * Pass an adapter via:
 * - `server.tx({ atomic: <adapter> }, fn)` — per-call override.
 * - `ServerConfig.txAtomic` — server-wide default for `atomic: true`.
 *
 * If neither is supplied and `atomic: true` is requested, reflectdb falls back to
 * the bundled drizzle adapter via dynamic import (no top-level dep). When
 * drizzle isn't installed the fallback throws a clear error directing users to
 * supply a `txAtomic` adapter.
 */
export interface TxAtomicAdapter {
	/** Begin a transaction on the given db handle. */
	begin(db: unknown): Promise<void>;
	/** Commit the in-flight transaction. */
	commit(db: unknown): Promise<void>;
	/** Roll back the in-flight transaction. */
	rollback(db: unknown): Promise<void>;
}
