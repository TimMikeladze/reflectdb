import type {
	AuthContext,
	CompactionConfig,
	OpType,
	RateLimitConfig,
	ServerTransport,
} from "../core/types.ts";
import type {
	InferRow,
	InferServerSetKeys,
	SyncPresenceDef,
	SyncQueryMap,
	SyncViewDef,
} from "../core/schema.ts";
import type {
	AuthCallback,
	AuthorizeAction,
	MutateResult,
	QueryOptions,
	ResolvedOp,
	RoomCallback,
	SyncEvent,
	TxFn,
	TxOptions,
} from "./types.ts";
import type { StorageAdapter } from "./handler.ts";
import { createServer } from "./server.ts";

// ── Config ──────────────────────────────────────────────────────────────

export interface TypedServerConfig<TQueries extends SyncQueryMap, TDb = unknown> {
	queries: TQueries;
	db?: TDb;
	transport: ServerTransport;
	serverId?: string;
	storage?: StorageAdapter;
	onEvent?: (event: SyncEvent) => void;
	/** Poll interval in ms for detecting changes from other server instances sharing the same storage. Enables HA mode. 0 or undefined to disable. */
	poll?: number;
	maxConnectionsPerUser?: number;
	/**
	 * Serve connections without an `auth()` callback, giving each session an
	 * `anon:<clientId>` identity. Without it a server that never calls `auth()`
	 * rejects the handshake instead of acking `hello` and then failing every
	 * later message as unauthenticated.
	 */
	allowAnonymous?: boolean;
	/** Abort a broadcast query that runs longer than this many ms. 0 disables. */
	queryTimeoutMs?: number;
	/** Max subscriber groups whose queries run concurrently per broadcast. Default: 8. */
	maxBroadcastConcurrency?: number;
	/** Adapter that wraps `server.tx({ atomic: true })` writes in a transaction. */
	txAtomic?: import("./tx-atomic.ts").TxAtomicAdapter;
}

// ── Params helper (typed params when declared, loose when not) ──────────

type ImplementParams<
	TQueries extends SyncQueryMap,
	K extends keyof TQueries,
> = TQueries[K] extends { params: infer P extends Record<string, unknown> }
	? P
	: Record<string, unknown>;

// ── Schema entry classification ────────────────────────────────────────

/** Keys whose value is a `SyncViewDef` (read-only computed query). */
type ViewKeys<TQueries extends SyncQueryMap> = {
	[K in keyof TQueries]: TQueries[K] extends SyncViewDef ? K : never;
}[keyof TQueries];

/** Keys whose value is a regular query (not view, not presence). */
type RegularKeys<TQueries extends SyncQueryMap> = {
	[K in keyof TQueries]: TQueries[K] extends SyncViewDef | SyncPresenceDef ? never : K;
}[keyof TQueries];

// ── ServerSet key constraint (must match schema-declared fields) ──────

type ServerSetKeys<
	TQueries extends SyncQueryMap,
	K extends keyof TQueries,
> = InferServerSetKeys<TQueries[K]>;

/** True when schema's `serverSet` is the array form (keys only) */
type IsServerSetArrayForm<
	TQueries extends SyncQueryMap,
	K extends keyof TQueries,
> = TQueries[K] extends { serverSet: readonly string[] } ? true : false;

/** Value: static or a function receiving auth/params context */
type ServerSetValue<TAuth extends AuthContext, TQueries extends SyncQueryMap, K extends keyof TQueries> =
	| unknown
	| ((ctx: { auth: TAuth; params: ImplementParams<TQueries, K> }) => unknown);

/**
 * `serverSet` shape on `implement(...)`:
 *  - schema declares no `serverSet` → field disallowed.
 *  - schema declares array form → field REQUIRED (values must be supplied).
 *  - schema declares object form → field OPTIONAL (overrides only).
 */
type ServerSetOption<
	TQueries extends SyncQueryMap,
	K extends keyof TQueries,
	TAuth extends AuthContext,
> = [ServerSetKeys<TQueries, K>] extends [never]
	? { serverSet?: undefined }
	: IsServerSetArrayForm<TQueries, K> extends true
		? { serverSet: { [F in ServerSetKeys<TQueries, K>]: ServerSetValue<TAuth, TQueries, K> } }
		: { serverSet?: Partial<{ [F in ServerSetKeys<TQueries, K>]: ServerSetValue<TAuth, TQueries, K> }> };

// ── Implement options (what goes in server.implement()) ─────────────────

/**
 * Options for `server.implement(...)`. Collapses to `never` for view/presence
 * entries — those have dedicated `server.view(...)` / `usePresence(...)` paths
 * and aren't writable through the implement surface.
 */
export type ImplementOptions<
	TQueries extends SyncQueryMap,
	K extends keyof TQueries,
	TAuth extends AuthContext,
	TDb,
> = TQueries[K] extends SyncViewDef | SyncPresenceDef
	? never
	: {
			query: (ctx: { auth: TAuth; params: ImplementParams<TQueries, K> }, db: TDb) => unknown;
			mutate?: (
				op: ResolvedOp,
				ctx: { auth: TAuth; params: ImplementParams<TQueries, K> },
				db: TDb,
			) => Promise<void | MutateResult>;
			authorize?: (
				action: AuthorizeAction,
				ctx: { auth: TAuth; params: ImplementParams<TQueries, K> },
				db: TDb,
			) => Promise<void>;
			broadcast?: "consistent" | "eager" | "eager-durable";
			flushInterval?: number;
			maxBufferSize?: number;
			/** Override change-detection tables (defaults to schema.tables or query key name) */
			tables?: string[];
			/**
			 * Total row count for `countHints`, independent of the window. Without
			 * it every broadcast fetches the full result set just to count it.
			 */
			count?: (
				ctx: { auth: TAuth; params: ImplementParams<TQueries, K> },
				db: TDb,
			) => Promise<number> | number;
			/**
			 * Collapse subscribers whose results are identical into one query
			 * execution per broadcast. See `QueryOptions.groupBy`.
			 */
			groupBy?: (ctx: { auth: TAuth; params: ImplementParams<TQueries, K> }) => string;
			/**
			 * Require subscriptions to resolve this room pattern (e.g.
			 * `"org/:orgId"`). Subscriptions that don't are rejected instead of
			 * silently becoming unscoped. See `QueryOptions.room`.
			 */
			room?: string;
		} & ServerSetOption<TQueries, K, TAuth>;

// ── View options (what goes in server.view()) ──────────────────────────

/** Function signature for a view's read-only query callback. */
export type ViewFn<
	TQueries extends SyncQueryMap,
	K extends keyof TQueries,
	TAuth extends AuthContext,
	TDb,
> = (
	ctx: { auth: TAuth; params: ImplementParams<TQueries, K> },
	db: TDb,
) => Promise<InferRow<TQueries, K>[]> | InferRow<TQueries, K>[];

// ── REST config ─────────────────────────────────────────────────────────

export interface RestConfig {
	/** URL prefix (default: "/api") */
	prefix?: string;
}

// ── Typed server interface ──────────────────────────────────────────────

export interface TypedSyncServer<
	TQueries extends SyncQueryMap,
	TAuth extends AuthContext = AuthContext,
	TDb = unknown,
> {
	auth(callback: AuthCallback): void;
	implement<K extends RegularKeys<TQueries> & string>(
		name: K,
		options: ImplementOptions<TQueries, K, TAuth, TDb>,
	): void;
	/**
	 * Register a read-only computed query. Compiles to `server.query(...)` with a
	 * mutate that throws `readonly_query`, so direct writes are blocked at runtime
	 * and `useSync(...).insert/update/remove` is blocked at the type level.
	 */
	view<K extends ViewKeys<TQueries> & string>(
		name: K,
		fn: ViewFn<TQueries, K, TAuth, TDb>,
	): void;
	room(pattern: string, callback: RoomCallback<TAuth>): void;
	rateLimit(config: RateLimitConfig): void;
	compaction(config: CompactionConfig): void;
	minSchemaVersion(version: number): void;
	runCompaction(): Promise<void>;
	notifyChange(tableName: string, roomKey?: string | null): Promise<void>;
	reserveOpId(opId: string): Promise<boolean>;
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
	 * Server-origin row write. Sugar over `applyServerOp` — generates rowId,
	 * routes through HLC + op log + broadcast pipeline.
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
	 * Atomic-ish write group with auto-notify. Tracks tables touched by drizzle
	 * `insert/update/delete` calls inside `fn` and fires one batched
	 * `notifyChange` per table on success. With `atomic: true` the work runs
	 * inside `db.transaction(...)` and rolls back on throw; without it, writes
	 * are not transactional but notifies are still skipped on throw.
	 */
	tx<T>(fn: TxFn<T>): Promise<T>;
	tx<T>(opts: TxOptions, fn: TxFn<T>): Promise<T>;
	lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
	tryLock<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
	/** `setInterval` wrapper — auto-disposes on `bun --hot` reload and on `close()`. */
	interval(ms: number, fn: () => void | Promise<void>): { clear(): void };
	/** `setTimeout` wrapper — auto-disposes on `bun --hot` reload and on `close()`. */
	timeout(ms: number, fn: () => void | Promise<void>): { clear(): void };
	close(): Promise<void>;
	/** Generate a REST fetch handler from registered implementations */
	rest(config?: RestConfig): (req: Request) => Promise<Response>;
}

// ── Stored implementation (captures callbacks for REST reuse) ───────────

interface StoredImpl {
	query: (ctx: { auth: AuthContext; params: Record<string, unknown> }, db: unknown) => unknown;
	mutate?: (
		op: ResolvedOp,
		ctx: { auth: AuthContext; params: Record<string, unknown> },
		db: unknown,
	) => Promise<void | MutateResult>;
	authorize?: (
		action: AuthorizeAction,
		ctx: { auth: AuthContext; params: Record<string, unknown> },
		db: unknown,
	) => Promise<void>;
	serverSet?: Record<string, unknown>;
	readonlyFields?: Set<string>;
	tables: string[];
	pk: string;
}

// ── Factory ─────────────────────────────────────────────────────────────

export function createSyncServer<
	TQueries extends SyncQueryMap,
	TDb = unknown,
	TAuth extends AuthContext = AuthContext,
>(config: TypedServerConfig<TQueries, TDb>): TypedSyncServer<TQueries, TAuth, TDb> {
	const server = createServer<TDb, TAuth>({
		db: config.db,
		transport: config.transport,
		serverId: config.serverId,
		storage: config.storage,
		onEvent: config.onEvent,
		poll: config.poll,
		maxConnectionsPerUser: config.maxConnectionsPerUser,
		allowAnonymous: config.allowAnonymous,
		queryTimeoutMs: config.queryTimeoutMs,
		maxBroadcastConcurrency: config.maxBroadcastConcurrency,
		txAtomic: config.txAtomic,
	});

	const implementations = new Map<string, StoredImpl>();
	let authCallback: AuthCallback | null = null;

	return {
		auth(callback: AuthCallback) {
			authCallback = callback;
			server.auth(callback);
		},

		implement<K extends RegularKeys<TQueries> & string>(
			name: K,
			impl: ImplementOptions<TQueries, K, TAuth, TDb>,
		) {
			const def = config.queries[name] as Record<string, unknown> | undefined;
			if (!def) {
				throw new Error(`Unknown query "${name}"`);
			}
			// Guard against runtime calls on view/presence names (the type system
			// already blocks this; the runtime check covers JS callers).
			if ((def as { __view?: boolean }).__view) {
				throw new Error(`use server.view("${name}", ...) for view queries`);
			}
			if ((def as { __presence?: boolean }).__presence) {
				throw new Error(`"${name}" is a presence channel, not a writable query`);
			}

			// `impl` is `never` for view/presence keys at the type level; the cast
			// here lets us read the regular-query fields.
			const o = impl as {
				query: StoredImpl["query"];
				mutate?: StoredImpl["mutate"];
				authorize?: StoredImpl["authorize"];
				serverSet?: Record<string, unknown>;
				broadcast?: "consistent" | "eager" | "eager-durable";
				flushInterval?: number;
				maxBufferSize?: number;
				tables?: string[];
				count?: QueryOptions<TAuth, TDb>["count"];
				groupBy?: QueryOptions<TAuth, TDb>["groupBy"];
				room?: string;
			};

			// Priority: implement.tables > schema.tables > query key name
			const tables =
				o.tables ?? (def.tables as string[] | undefined) ?? [name];
			const pk = (def.pk as string | undefined) ?? "id";
			const conflict = def.conflict as
				| import("../core/types.ts").ConflictPolicy
				| undefined;
			const readonly = def.readonly as readonly string[] | undefined;
			const countHints = def.countHints as boolean | undefined;
			const defServerSet = def.serverSet;

			// Merge serverSet:
			//  - schema array form: only impl.serverSet supplies values.
			//  - schema object form: schema supplies values; impl.serverSet
			//    (if present) overrides per-key for per-environment tweaks.
			const schemaServerSet =
				defServerSet && !Array.isArray(defServerSet)
					? (defServerSet as Record<string, unknown>)
					: undefined;
			const implServerSet = o.serverSet;
			const mergedServerSet: Record<string, unknown> | undefined =
				schemaServerSet || implServerSet
					? { ...(schemaServerSet ?? {}), ...(implServerSet ?? {}) }
					: undefined;

			implementations.set(name, {
				query: o.query,
				mutate: o.mutate,
				authorize: o.authorize,
				serverSet: mergedServerSet,
				readonlyFields: readonly ? new Set(readonly) : undefined,
				tables,
				pk,
			});

			server.query(name, o.query as never, {
				tables,
				pk,
				conflict,
				readonly: readonly ? [...readonly] : undefined,
				serverSet: mergedServerSet,
				countHints,
				count: o.count as never,
				groupBy: o.groupBy as never,
				room: o.room,
				broadcast: o.broadcast,
				flushInterval: o.flushInterval,
				maxBufferSize: o.maxBufferSize,
				authorize: o.authorize as never,
				mutate: o.mutate as never,
			});
		},

		view<K extends ViewKeys<TQueries> & string>(
			name: K,
			fn: ViewFn<TQueries, K, TAuth, TDb>,
		) {
			const def = config.queries[name] as
				| (SyncViewDef & { tables?: string[] })
				| undefined;
			if (!def || !(def as { __view?: boolean }).__view) {
				throw new Error(`"${name}" is not declared as a view in defineSyncQueries`);
			}
			// Views are read-only; mutate throws so any client write attempt is
			// rejected with a `readonly_query` reason.
			const tables = def.deps ?? def.tables ?? [name];
			server.query(name, fn as never, {
				tables,
				mutate: async () => {
					const { MutationError } = await import("../core/types.ts");
					throw new MutationError(
						"readonly_query",
						`"${name}" is a view and is read-only`,
					);
				},
			});
		},

		rest(restConfig?: RestConfig) {
			const prefix = restConfig?.prefix ?? "/api";

			const runOp = (
				type: OpType,
				queryName: string,
				rowId: string,
				payload: Record<string, unknown> | null,
				impl: StoredImpl,
				ctx: { auth: AuthContext; params: Record<string, unknown> },
			) =>
				server.applyServerOp(
					{ type, table: queryName, rowId, payload },
					async (stamped) => {
						const op: ResolvedOp = { ...stamped, type } as ResolvedOp;
						if (impl.authorize) {
							await impl.authorize({ type: "write", table: queryName, op }, ctx, config.db);
						}
						await impl.mutate!(op, ctx, config.db);
					},
				);

			return async (req: Request): Promise<Response> => {
				const url = new URL(req.url);
				const path = url.pathname.slice(prefix.length);
				const segments = path.split("/").filter(Boolean);
				const queryName = segments[0];
				const rowId = segments[1];

				if (!queryName) {
					return Response.json({ queries: [...implementations.keys()] });
				}

				const impl = implementations.get(queryName);
				if (!impl) {
					return Response.json({ error: "not_found" }, { status: 404 });
				}

				// Auth
				let auth: AuthContext;
				try {
					if (!authCallback) {
						auth = { userId: "anonymous" };
					} else {
						auth = await authCallback(req);
					}
				} catch {
					return Response.json({ error: "unauthorized" }, { status: 401 });
				}

				const params = Object.fromEntries(url.searchParams);
				const ctx = { auth, params };

				// Idempotency-Key header: mutating methods that carry it are
				// de-duplicated across restarts via the shared processed_ops
				// store. A replay returns 200 with no body side-effect.
				const idempotencyKey = req.headers.get("Idempotency-Key") ?? req.headers.get("idempotency-key");
				const isMutation = req.method !== "GET";
				if (isMutation && idempotencyKey) {
					const fresh = await server.reserveOpId(`rest:${queryName}:${idempotencyKey}`);
					if (!fresh) {
						return Response.json({ ok: true, replayed: true });
					}
				}

				try {
					switch (req.method) {
						case "GET": {
							// Authorize read access — parity with sync handleSyncDeclare
							// which runs authorize({type:"read"}) before executing the
							// query. Without this, REST GET bypasses tenant filtering
							// declared in the authorize callback.
							if (impl.authorize) {
								try {
									await impl.authorize(
										{ type: "read", table: queryName, params },
										ctx,
										config.db,
									);
								} catch {
									return Response.json({ error: "forbidden" }, { status: 403 });
								}
							}
							const result = impl.query(ctx, config.db);
							const resolved =
								result && typeof (result as Promise<unknown>).then === "function"
									? await (result as Promise<unknown>)
									: result;
							const rows = Array.isArray(resolved) ? (resolved as Record<string, unknown>[]) : [];

							if (rowId) {
								const row = rows.find((r) => r[impl.pk] === rowId);
								return row
									? Response.json(row)
									: Response.json({ error: "not_found" }, { status: 404 });
							}
							return Response.json(rows);
						}

						case "POST": {
							if (!impl.mutate) {
								return Response.json({ error: "readonly" }, { status: 405 });
							}
							const raw = await req.json();

							// Batch: POST with array body. Per-item results so callers
							// can distinguish partial failure: items before the error
							// are already persisted. Use 207 Multi-Status when any
							// item fails so clients react instead of treating partial
							// success as full success.
							if (Array.isArray(raw)) {
								type Result =
									| { ok: true; id: string }
									| { ok: false; id: string; error: string };
								const results: Result[] = [];
								let anyFailed = false;
								for (const item of raw as Record<string, unknown>[]) {
									const id = (item[impl.pk] as string) ?? crypto.randomUUID();
									const payload = { ...item };
									delete payload[impl.pk];
									stripReadonly(payload, impl.readonlyFields);
									applyServerSet(payload, impl.serverSet, ctx);
									try {
										await runOp("insert", queryName, id, payload, impl, ctx);
										results.push({ ok: true, id });
									} catch (err) {
										anyFailed = true;
										results.push({
											ok: false,
											id,
											error: err instanceof Error ? err.message : String(err),
										});
									}
								}
								// Preserve back-compat top-level ids[] = successful ids only.
								const ids = results.filter((r) => r.ok).map((r) => r.id);
								return Response.json(
									{ ids, results },
									{ status: anyFailed ? 207 : 201 },
								);
							}

							// Single insert
							const body = raw as Record<string, unknown>;
							const id = (body[impl.pk] as string) ?? crypto.randomUUID();
							const payload = { ...body };
							delete payload[impl.pk];
							stripReadonly(payload, impl.readonlyFields);
							applyServerSet(payload, impl.serverSet, ctx);

							await runOp("insert", queryName, id, payload, impl, ctx);
							return Response.json({ id }, { status: 201 });
						}

						case "PUT":
						case "PATCH": {
							if (!impl.mutate) {
								return Response.json({ error: "readonly" }, { status: 405 });
							}
							if (!rowId) {
								return Response.json({ error: "missing_id" }, { status: 400 });
							}
							const body = (await req.json()) as Record<string, unknown>;
							const payload = { ...body };
							delete payload[impl.pk];
							stripReadonly(payload, impl.readonlyFields);
							applyServerSet(payload, impl.serverSet, ctx);

							await runOp("update", queryName, rowId, payload, impl, ctx);
							return Response.json({ ok: true });
						}

						case "DELETE": {
							if (!impl.mutate) {
								return Response.json({ error: "readonly" }, { status: 405 });
							}
							if (!rowId) {
								return Response.json({ error: "missing_id" }, { status: 400 });
							}
							await runOp("delete", queryName, rowId, null, impl, ctx);
							return Response.json({ ok: true });
						}

						default:
							return Response.json({ error: "method_not_allowed" }, { status: 405 });
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (message.includes("forbidden") || message.includes("unauthorized")) {
						return Response.json({ error: message }, { status: 403 });
					}
					return Response.json({ error: message }, { status: 500 });
				}
			};
		},

		room: server.room,
		rateLimit: server.rateLimit,
		compaction: server.compaction,
		minSchemaVersion: server.minSchemaVersion,
		runCompaction: server.runCompaction,
		notifyChange: server.notifyChange,
		reserveOpId: server.reserveOpId,
		applyServerOp: server.applyServerOp,
		emit: server.emit,
		tx: server.tx,
		lock: server.lock,
		tryLock: server.tryLock,
		interval: server.interval,
		timeout: server.timeout,
		close: server.close,
	};
}

function stripReadonly(
	payload: Record<string, unknown>,
	readonlyFields: Set<string> | undefined,
): void {
	if (!readonlyFields) return;
	for (const key of readonlyFields) {
		delete payload[key];
	}
}

function applyServerSet(
	payload: Record<string, unknown>,
	serverSet: Record<string, unknown> | undefined,
	ctx: { auth: AuthContext; params: Record<string, unknown> },
): void {
	if (!serverSet) return;
	for (const [key, val] of Object.entries(serverSet)) {
		payload[key] = typeof val === "function" ? val(ctx) : val;
	}
}
