import type {
	AuthContext,
	CompactionConfig,
	ConflictPolicy,
	OpType,
	RateLimitConfig,
} from "../core/types.ts";
import type { EphemeralAdapter } from "./ephemeral/types.ts";
import type { TxAtomicAdapter } from "./tx-atomic.ts";

export type SyncEvent =
	| { type: "client_connected"; clientId: string }
	| { type: "client_disconnected"; clientId: string }
	| { type: "auth_failed"; clientId: string; error: unknown }
	| { type: "message_invalid"; clientId: string; error: string }
	| { type: "ops_processed"; clientId: string; accepted: number; rejected: number }
	| { type: "bootstrap"; clientId: string; queries: number }
	| { type: "resume"; clientId: string; queries: number; tablesChanged: number }
	| { type: "compaction"; deletedOps: number }
	| { type: "ephemeral_full"; currentSize: number }
	| { type: "ephemeral_rate_limited"; clientId: string }
	| { type: "query_error"; clientId: string; queryName: string; phase: string; error: unknown }
	| { type: "queue_overflow"; clientId: string; depth: number }
	| { type: "eager_flush_failed"; table: string; rowId: string; error: unknown };

export interface ServerConfig<TDb = unknown> {
	db?: TDb;
	transport: import("../core/types.ts").ServerTransport;
	serverId?: string;
	storage?: import("./handler.ts").StorageAdapter;
	onEvent?: (event: SyncEvent) => void;
	/** Poll interval in ms for detecting changes from other server instances sharing the same storage. Enables HA mode. 0 or undefined to disable. */
	poll?: number;
	/** Max concurrent sessions per userId. Oldest is evicted on overflow. */
	maxConnectionsPerUser?: number;
	/**
	 * Serve connections without an `auth()` callback, giving each session an
	 * `anon:<clientId>` identity. Without it a server that never calls `auth()`
	 * rejects the handshake rather than acking `hello` and then failing every
	 * subsequent message as unauthenticated.
	 */
	allowAnonymous?: boolean;
	/**
	 * Abort a broadcast query that runs longer than this many ms, so one slow
	 * query can't stall fanout to every other subscriber. 0 disables.
	 * Note: this abandons the promise, it does not cancel the underlying
	 * database work.
	 */
	queryTimeoutMs?: number;
	/** Max subscriber groups whose queries run concurrently per broadcast. Default: 8. */
	maxBroadcastConcurrency?: number;
	/**
	 * Adapter that wraps `server.tx({ atomic: true })` writes in a transaction.
	 * Required when using `atomic: true` against a non-drizzle handle (kysely,
	 * prisma, raw SQL). Drizzle handles auto-fall-back via dynamic import when
	 * this is absent. See `TxAtomicAdapter`.
	 */
	txAtomic?: TxAtomicAdapter;
	/**
	 * Ephemeral (presence, cursors, typing) storage and fan-out.
	 *
	 * The default is in-process: correct on one node, invisible across a fleet,
	 * since each instance holds its own map and its own sockets. Supply an
	 * adapter backed by shared infrastructure to make presence span instances.
	 */
	ephemeral?: {
		adapter?: EphemeralAdapter;
		/** Entry ceiling for the default in-process store. Default: 10_000. */
		maxEntries?: number;
	};
}

export interface QueryContext<TAuth extends AuthContext = AuthContext> {
	auth: TAuth;
	params: Record<string, unknown>;
	/**
	 * Row cap the server needs for this execution, or undefined for "all rows".
	 *
	 * Set for windowed subscriptions. Applying it as `.limit(ctx.limit)` pushes
	 * windowing into SQL; ignore it and the server still slices in JS, which is
	 * correct but fetches the whole table on every broadcast. Pair with
	 * `QueryOptions.count` so count hints don't force a full fetch either.
	 */
	limit?: number;
}

// ── Mutation Types ──────────────────────────────────────────────────────────

export interface ResolvedOp {
	type: OpType;
	table: string;
	rowId: string;
	payload: Record<string, unknown> | null;
	hlc: string;
}

export interface MutateResult {
	affected?: string[];
}

export interface MutationContext<TAuth extends AuthContext = AuthContext> {
	auth: TAuth;
	params: Record<string, unknown>;
}

export type AuthorizeAction =
	| { type: "read"; table: string; params: Record<string, unknown> }
	| { type: "write"; table: string; op: ResolvedOp };

// ── Query Options ───────────────────────────────────────────────────────────

export interface QueryOptions<TAuth extends AuthContext = AuthContext, TDb = unknown> {
	tables: string[];
	/** Primary key column name. Defaults to "id". Single-column only. */
	pk?: string;
	/**
	 * How concurrent writes to the same row are resolved.
	 *
	 * Resolution compares the incoming op against **reflectdb's mirror** (the
	 * JSONB row store + per-column clocks it maintains), not against your
	 * database. The two agree as long as every write to the table goes through
	 * reflectdb and `mutate` persists the resolved payload verbatim. They diverge
	 * when `mutate` transforms the payload, when database defaults/triggers
	 * rewrite it, or when something writes the table out of band — and then
	 * conflicts are decided against state clients never observed, because
	 * snapshots and deltas are read from your database.
	 *
	 * Ignored by both `eager` broadcast modes.
	 */
	conflict?: ConflictPolicy;
	serverSet?: Record<string, unknown>;
	readonly?: string[];
	countHints?: boolean;
	/**
	 * Require this query's subscriptions to resolve the named room pattern
	 * (e.g. `"org/:orgId"`). A `sync_declare` whose params don't produce a
	 * valid key for it is rejected instead of falling back to an unscoped,
	 * cross-room subscription. Use for any query carrying tenant data.
	 */
	room?: string;
	/**
	 * Total row count for `countHints`, independent of the window.
	 *
	 * Without it, count hints force the broadcast engine to fetch every row of
	 * every windowed query on every write just to call `.length` on the result.
	 * Implement it as a `SELECT count(*)` and windowing becomes a real limit.
	 */
	count?: (ctx: QueryContext<TAuth>, db: TDb) => Promise<number> | number;
	/**
	 * Collapse subscribers into a shared query execution.
	 *
	 * By default the broadcast engine groups subscribers by their full auth
	 * context, so a write costs one query execution per connected client. When
	 * a query's results depend only on a coarser key — a tenant id, a room, or
	 * nothing at all — return that key here and every client sharing it is
	 * served by ONE execution and one diff.
	 *
	 * Return a key that captures every input the query reads from `auth`. Two
	 * clients sharing a key MUST be entitled to byte-identical rows; collapsing
	 * clients that aren't leaks rows across the boundary.
	 *
	 * ```ts
	 * // Query filters only on orgId — all members of an org share a result set.
	 * groupBy: ({ auth }) => String(auth.orgId)
	 * ```
	 */
	groupBy?: (ctx: { auth: TAuth; params: Record<string, unknown> }) => string;
	/**
	 * Broadcast strategy.
	 *
	 * - "consistent" (default): run the conflict pipeline, persist, then
	 *   broadcast by diffing each subscriber's re-executed query result.
	 * - "eager-durable": skip conflict resolution, persist to reflectdb's mirror
	 *   atomically, then broadcast the delta directly. Low latency, and the
	 *   mirror write can't be lost to a crash after the broadcast.
	 * - "eager": broadcast immediately, batch-persist to the mirror in the
	 *   background. AT-MOST-ONCE for the mirror across a crash: subscribers
	 *   may hold deltas the server forgets after restart. Only safe when
	 *   `mutate` is durable to your own database (the mirror becomes a
	 *   delivery hint, not a source of truth) AND clients tolerate
	 *   resume-via-snapshot. Prefer "eager-durable" unless you have measured
	 *   persistence latency as a real bottleneck.
	 *
	 * Both eager modes DO enforce `readonly`, `serverSet`, clock drift, the
	 * batch cap and rate limits. What they skip is conflict resolution: a
	 * declared `conflict` policy does not apply and writes land last-writer-wins.
	 *
	 * Durability caveat that applies to EVERY mode: `mutate` writes your
	 * database and reflectdb writes its own mirror + op log in a separate commit.
	 * "Atomic" here means the mirror row and its op-log entry commit together,
	 * not that they commit with your database write. A crash between the two
	 * leaves your database ahead of the mirror.
	 */
	broadcast?: "consistent" | "eager" | "eager-durable";
	/** Flush interval in ms for eager broadcast buffer. Default: 200. */
	flushInterval?: number;
	/** Max buffered ops per query before forcing a flush. Default: 1000. */
	maxBufferSize?: number;
	authorize?: (action: AuthorizeAction, ctx: MutationContext<TAuth>, db: TDb) => Promise<void>;
	mutate?: (op: ResolvedOp, ctx: MutationContext<TAuth>, db: TDb) => Promise<void | MutateResult>;
}

export type QueryCallback<TAuth extends AuthContext = AuthContext, TDb = unknown> = (
	ctx: QueryContext<TAuth>,
	db: TDb,
) => unknown;

export type AuthCallback = (req: Request) => Promise<AuthContext>;

// ── Transaction (tx) Types ─────────────────────────────────────────────

/**
 * Proxy passed to `server.tx(fn)`. Forwards all calls through to the
 * underlying db handle; for drizzle handles, `insert/update/delete` are
 * intercepted to auto-record touched tables. `select` is NOT a touch.
 *
 * Non-drizzle data layers (kysely, prisma, raw SQL) call `tx.touch(name)`
 * after each write to flag the table for the trailing `notifyChange` pass.
 * Drizzle users may also call `tx.touch` to add a table the proxy didn't
 * detect (e.g. raw SQL escape hatch through `tx.run(...)`).
 *
 * Typed loosely as the underlying handle to avoid coupling to a specific
 * dialect; `touch` is appended explicitly for IDE discoverability.
 */
// biome-ignore lint/suspicious/noExplicitAny: drizzle handle shape varies per dialect
export type TxProxy = any & { touch(table: string): void };

export type TxFn<T> = (tx: TxProxy) => Promise<T>;

export interface TxOptions {
	/**
	 * Wrap the work in BEGIN/COMMIT for SQL atomicity. Defaults to `true` —
	 * partial writes on throw are usually a footgun, so opt OUT explicitly
	 * (`atomic: false`) only when you've measured it as a perf bottleneck.
	 * Either way, notifies fire only on full success.
	 *
	 * Three accepted forms:
	 * - `true` (default): use `ServerConfig.txAtomic` if set, otherwise fall
	 *   back to the bundled drizzle adapter (lazy-loaded — no top-level
	 *   `drizzle-orm` dep). Throws if drizzle isn't installed and no adapter
	 *   is configured.
	 * - `false`: skip BEGIN/COMMIT entirely. Notifies still fire only on
	 *   full success.
	 * - `<TxAtomicAdapter>`: per-call override — use this adapter for the
	 *   one-off write, ignoring `ServerConfig.txAtomic`.
	 *
	 * Note: with multi-connection adapters (postgres pool) atomicity requires
	 * that BEGIN/COMMIT and the writes share a connection. Pass a single-connection
	 * handle when atomicity is load-bearing.
	 */
	atomic?: boolean | TxAtomicAdapter;
}

export interface RoomCallbackResult {
	ok: boolean;
	reason?: string;
}

export interface RoomCallback<TAuth extends AuthContext = AuthContext> {
	(ctx: {
		params: Record<string, string>;
		auth: TAuth;
	}): void | RoomCallbackResult | Promise<void | RoomCallbackResult>;
}

export interface SyncServer<TAuth extends AuthContext = AuthContext, TDb = unknown> {
	auth(callback: AuthCallback): void;
	query(name: string, callback: QueryCallback<TAuth, TDb>, options: QueryOptions<TAuth, TDb>): void;
	room(pattern: string, callback: RoomCallback<TAuth>): void;
	rateLimit(config: RateLimitConfig): void;
	compaction(config: CompactionConfig): void;
	minSchemaVersion(version: number): void;
	runCompaction(): Promise<void>;
	notifyChange(tableName: string, roomKey?: string | null): Promise<void>;
	/**
	 * Idempotency gate — returns true if this opId is fresh. Callers use
	 * this to dedupe REST retries (e.g. Idempotency-Key header).
	 */
	reserveOpId(opId: string): Promise<boolean>;
	/**
	 * Route a server-originated op (e.g. REST write) through the sync
	 * pipeline: assign server HLC, persist atomically, broadcast.
	 * Call after authorize + mutate to keep the op log consistent.
	 *
	 * Pass `options.roomKey` to scope the broadcast to a tenant/room. Without
	 * it the broadcast goes to all subscribers of the affected query —
	 * leaking writes across tenants in multi-tenant apps.
	 */
	applyServerOp(
		op: {
			type: OpType;
			table: string;
			rowId: string;
			payload: Record<string, unknown> | null;
		},
		execute?: (stamped: {
			type: OpType;
			table: string;
			rowId: string;
			payload: Record<string, unknown> | null;
			hlc: string;
		}) => Promise<void>,
		options?: { roomKey?: string | null },
	): Promise<{ hlc: string; resolvedRow: Record<string, unknown> | null }>;
	/**
	 * Server-origin row write. Sugar over `applyServerOp` — generates rowId
	 * (uses `payload.id` if present, else uuid), routes through HLC + op log
	 * + broadcast pipeline. Does not apply schema serverSet/readonly stripping;
	 * server is the trusted writer.
	 */
	emit(
		table: string,
		payload: Record<string, unknown>,
		options?: {
			rowId?: string;
			type?: OpType;
			roomKey?: string | null;
		},
	): Promise<{ hlc: string; rowId: string }>;
	/**
	 * Atomic-ish write group with auto-notify. Wraps the server's underlying
	 * drizzle `db` in a proxy that tracks tables touched by
	 * `insert/update/delete`; on success, fires one `notifyChange` per touched
	 * table. With `atomic: true`, runs inside `db.transaction(...)`; without
	 * it, writes are not transactional but notifies are still skipped on
	 * throw. Throws if the server has no `db` configured.
	 */
	tx<T>(fn: TxFn<T>): Promise<T>;
	tx<T>(opts: TxOptions, fn: TxFn<T>): Promise<T>;
	lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
	tryLock<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
	/**
	 * `setInterval` wrapper that auto-disposes on `bun --hot` reload and on
	 * `server.close()`. Errors from `fn` are logged, not thrown.
	 */
	interval(ms: number, fn: () => void | Promise<void>): { clear(): void };
	/**
	 * `setTimeout` wrapper that auto-disposes on `bun --hot` reload and on
	 * `server.close()`. Errors from `fn` are logged, not thrown.
	 */
	timeout(ms: number, fn: () => void | Promise<void>): { clear(): void };
	close(): Promise<void>;
}
