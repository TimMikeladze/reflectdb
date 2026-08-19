import type { AuthContext, CompactionConfig, OpType, RateLimitConfig } from "../core/types.ts";
import { createRateLimiter } from "./enforcement.ts";
import { MessageHandler } from "./handler.ts";
import type { TxAtomicAdapter } from "./tx-atomic.ts";

import type {
	AuthCallback,
	QueryCallback,
	QueryOptions,
	RoomCallback,
	ServerConfig,
	SyncServer,
	TxFn,
	TxOptions,
	TxProxy,
} from "./types.ts";

// Drizzle helpers used for tx auto-detect + the default atomic adapter.
// Lazy-loaded once per process via dynamic import so apps that never call
// `tx({ atomic: true })` against a drizzle handle don't pay the drizzle
// install cost. `undefined` = not yet attempted; `null` = attempted, not
// available (drizzle not installed).
type DrizzleHelpers = {
	getTableName: (t: unknown) => string;
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
};
let drizzleHelpersPromise: Promise<DrizzleHelpers | null> | undefined;

function loadDrizzleHelpers(): Promise<DrizzleHelpers | null> {
	if (drizzleHelpersPromise) return drizzleHelpersPromise;
	drizzleHelpersPromise = (async () => {
		try {
			const mod = await import("drizzle-orm");
			return {
				getTableName: mod.getTableName as (t: unknown) => string,
				sql: mod.sql as unknown as DrizzleHelpers["sql"],
			};
		} catch {
			return null;
		}
	})();
	return drizzleHelpersPromise;
}

/** Default `TxAtomicAdapter` — drizzle-shaped. Built lazily so the import is
 *  only evaluated when `atomic: true` is actually used and drizzle is present. */
function makeDrizzleFallbackAtomic(helpers: DrizzleHelpers): TxAtomicAdapter {
	return {
		async begin(db) {
			const handle = db as { run?: (q: unknown) => unknown };
			if (typeof handle?.run !== "function") {
				throw new Error(
					"server.tx({ atomic: true }) requires either a drizzle db with run() or a `txAtomic` adapter on server config",
				);
			}
			await Promise.resolve(handle.run(helpers.sql`BEGIN`));
		},
		async commit(db) {
			const handle = db as { run?: (q: unknown) => unknown };
			await Promise.resolve(handle.run!(helpers.sql`COMMIT`));
		},
		async rollback(db) {
			const handle = db as { run?: (q: unknown) => unknown };
			await Promise.resolve(handle.run!(helpers.sql`ROLLBACK`));
		},
	};
}

/**
 * Compile a room pattern like `org/:orgId/team/:teamId` into a matcher.
 *
 * Literal segments are regex-escaped: an unescaped `.` or `+` in a pattern
 * would otherwise widen the match (`a.b` matching `axb`) and let one room's
 * key satisfy another room's ACL check.
 */
function buildRoomRegex(pattern: string): {
	regex: RegExp;
	paramNames: string[];
} {
	const paramNames: string[] = [];
	let regexStr = "";
	let lastIndex = 0;
	const paramPattern = /:(\w+)/g;
	let match: RegExpExecArray | null = paramPattern.exec(pattern);
	while (match !== null) {
		regexStr += escapeRegex(pattern.slice(lastIndex, match.index));
		paramNames.push(match[1]!);
		regexStr += "([^/]+)";
		lastIndex = match.index + match[0].length;
		match = paramPattern.exec(pattern);
	}
	regexStr += escapeRegex(pattern.slice(lastIndex));
	return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createServer<TDb = unknown, TAuth extends AuthContext = AuthContext>(
	config: ServerConfig<TDb>,
): SyncServer<TAuth, TDb> {
	const handler = new MessageHandler<TAuth>({
		transport: config.transport,
		serverId: config.serverId ?? crypto.randomUUID(),
		db: config.db,
		onEvent: config.onEvent,
		maxConnectionsPerUser: config.maxConnectionsPerUser,
		allowAnonymous: config.allowAnonymous,
		queryTimeoutMs: config.queryTimeoutMs,
		maxBroadcastConcurrency: config.maxBroadcastConcurrency,
	});

	if (config.storage) {
		handler.setStorage(config.storage);
	}

	if (config.ephemeral?.maxEntries !== undefined) {
		handler.setMaxEphemeralEntries(config.ephemeral.maxEntries);
	}
	// After maxEntries: an explicit adapter owns its own capacity policy and
	// must not be replaced by the default store.
	if (config.ephemeral?.adapter) {
		handler.setEphemeralAdapter(config.ephemeral.adapter);
	}

	let compactionConfig: CompactionConfig | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	// Per-key chained-promise mutex. Entry exists only while a chain is in
	// flight; each `.finally` removes the entry IFF it's still the tail, so
	// abandoned chains can't leak across keys.
	const lockChains = new Map<string, Promise<unknown>>();

	// Track active timers so server.close() can stop them. Stored as the
	// underlying Node/Bun timer handle; we clear via clearInterval/clearTimeout.
	const activeTimers = new Set<ReturnType<typeof setTimeout>>();

	if (config.poll && config.poll > 0) {
		// Skip overlapping ticks: if a slow notifyChange round is still running
		// when the next interval fires, dropping the tick is correct (the next
		// poll will pick up everything). Without this guard, slow queries pile
		// up overlapping broadcasts and unhandled rejections crash the process.
		let polling = false;
		pollTimer = setInterval(() => {
			if (polling) return;
			polling = true;
			(async () => {
				try {
					// Detects what actually changed instead of re-running every
					// query for every subscriber group on every tick.
					await handler.pollRemoteChanges();
				} catch (err) {
					console.error("[reflectdb] poll failed:", err);
				} finally {
					polling = false;
				}
			})();
		}, config.poll);
	}

	const server: SyncServer<TAuth, TDb> = {
		auth(callback: AuthCallback): void {
			handler.setAuth(callback);
		},

		query(
			name: string,
			callback: QueryCallback<TAuth, TDb>,
			options: QueryOptions<TAuth, TDb>,
		): void {
			const tableDependencies = new Set(options.tables);

			// Warn about options ignored in eager broadcast modes. Both "eager"
			// and "eager-durable" skip conflict resolution — readonly/serverSet
			// ARE enforced on both, but the conflict policy is not, and a query
			// that declares one gets last-writer-wins instead.
			if (options?.broadcast === "eager" || options?.broadcast === "eager-durable") {
				if (options.conflict) {
					console.warn(
						`[reflectdb] Query "${name}" has broadcast: "${options.broadcast}" — conflict: "${
							typeof options.conflict === "string" ? options.conflict : "custom"
						}" will be ignored (conflict resolution is skipped for eager queries; writes apply last-writer-wins)`,
					);
				}
			}

			handler.setQuery(name, {
				name,
				callback: callback as QueryCallback,
				tableDependencies,
				options: options as QueryOptions,
			});
		},

		room(pattern: string, callback: RoomCallback<TAuth>): void {
			const { regex, paramNames } = buildRoomRegex(pattern);
			handler.setRoom({
				pattern,
				regex,
				paramNames,
				callback: callback as RoomCallback,
			});
		},

		rateLimit(cfg: RateLimitConfig): void {
			handler.setRateLimiter(createRateLimiter(cfg));
			if (cfg.ephemeralPerSecond !== undefined) {
				handler.setEphemeralRateLimit(cfg.ephemeralPerSecond);
			}
		},

		compaction(cfg: CompactionConfig): void {
			compactionConfig = cfg;
		},

		minSchemaVersion(version: number): void {
			handler.setMinSchemaVersion(version);
		},

		async runCompaction(): Promise<void> {
			if (!compactionConfig) return;
			const minOpAge = parseDuration(compactionConfig.minOpAge);
			await handler.runCompaction(minOpAge);
		},

		async notifyChange(tableName: string, roomKey?: string | null): Promise<void> {
			await handler.notifyChange(tableName, roomKey);
		},

		async reserveOpId(opId: string): Promise<boolean> {
			return handler.reserveOpId(opId);
		},

		async applyServerOp(op, execute, options) {
			return handler.applyServerOp(op, execute, options);
		},

		async emit(
			table: string,
			payload: Record<string, unknown>,
			options?: { rowId?: string; type?: OpType; roomKey?: string | null },
		): Promise<{ hlc: string; rowId: string }> {
			const type = options?.type ?? "insert";
			const rowId =
				options?.rowId ??
				((payload.id as string | undefined) ?? crypto.randomUUID());
			const result = await handler.applyServerOp(
				{ type, table, rowId, payload },
				undefined,
				options?.roomKey !== undefined ? { roomKey: options.roomKey } : undefined,
			);
			return { hlc: result.hlc, rowId };
		},

		tx<T>(arg1: TxFn<T> | TxOptions, arg2?: TxFn<T>): Promise<T> {
			// Default atomic: true — partial-writes-on-throw is a footgun by default.
			const rawOpts: TxOptions = typeof arg1 === "function" ? {} : arg1;
			const opts: TxOptions = { atomic: true, ...rawOpts };
			const fn: TxFn<T> = typeof arg1 === "function" ? arg1 : arg2!;
			if (config.db == null) {
				return Promise.reject(
					new Error("server.tx requires a db on the server config"),
				);
			}
			const touched = new Set<string>();

			// Proxy traps insert/update/delete to record touched table names via
			// drizzle's getTableName() (when drizzle is installed). select is
			// intentionally NOT counted — reads don't change anything and
			// shouldn't trigger broadcasts. `tx.touch(name)` is the manual
			// escape hatch for non-drizzle data layers (kysely, prisma, raw
			// SQL): writers call it after each mutation so notifies fire on
			// the right tables.
			//
			// `getTableNameFn` is captured per-call after the drizzle import
			// resolves; if drizzle isn't installed, the auto-detect silently
			// falls through and `tx.touch` is the only path.
			const wrap = (
				target: unknown,
				getTableNameFn: ((t: unknown) => string) | undefined,
			): TxProxy =>
				new Proxy(target as object, {
					get(t, prop, receiver) {
						if (prop === "touch") {
							return (name: string) => {
								touched.add(name);
							};
						}
						const value = Reflect.get(t, prop, receiver);
						if (
							(prop === "insert" || prop === "update" || prop === "delete") &&
							typeof value === "function"
						) {
							return (table: unknown, ...rest: unknown[]) => {
								if (getTableNameFn) {
									try {
										touched.add(getTableNameFn(table));
									} catch {
										// Non-drizzle table object — fall through without tracking.
										// Caller can use `tx.touch("name")` for explicit notification.
									}
								}
								return (value as (...args: unknown[]) => unknown).call(
									t,
									table,
									...rest,
								);
							};
						}
						// Bind callable methods so `this` stays the underlying handle
						return typeof value === "function" ? value.bind(t) : value;
					},
				});

			const run = async (): Promise<T> => {
				// Lazy-load drizzle helpers once per process. Returns null when
				// drizzle isn't installed; tx still works in that case as long
				// as the caller uses `tx.touch(name)` and supplies a `txAtomic`
				// adapter (or sets `atomic: false`).
				const drizzleHelpers = await loadDrizzleHelpers();
				const getTableNameFn = drizzleHelpers?.getTableName;

				// Resolve the atomic adapter: per-call > server config > drizzle
				// fallback. `false` means no atomicity wrapper at all.
				let atomicAdapter: TxAtomicAdapter | undefined;
				if (opts.atomic && typeof opts.atomic === "object") {
					atomicAdapter = opts.atomic;
				} else if (opts.atomic === true) {
					if (config.txAtomic) {
						atomicAdapter = config.txAtomic;
					} else if (drizzleHelpers) {
						atomicAdapter = makeDrizzleFallbackAtomic(drizzleHelpers);
					} else {
						throw new Error(
							"server.tx({ atomic: true }) requires either a drizzle db (install `drizzle-orm`) or a `txAtomic` adapter on server config",
						);
					}
				}

				let result: T;
				if (atomicAdapter) {
					// Manual BEGIN/COMMIT/ROLLBACK — drizzle's async
					// `db.transaction(async fn)` is unsafe on the bun-sqlite dialect
					// (sync transaction commits before the async body finishes), so
					// the default drizzle adapter routes through raw `db.run(...)`
					// which is portable across sqlite and postgres dialects.
					await atomicAdapter.begin(config.db);
					try {
						result = await fn(wrap(config.db, getTableNameFn));
						await atomicAdapter.commit(config.db);
					} catch (err) {
						await atomicAdapter.rollback(config.db);
						throw err;
					}
				} else {
					result = await fn(wrap(config.db, getTableNameFn));
				}
				// Notifies fire only on full success — on throw, the catch in the
				// outer chain skips this loop entirely. Route through `server.notifyChange`
				// (not handler directly) so test wrappers and instrumentation see the call.
				for (const t of touched) {
					await server.notifyChange(t);
				}
				return result;
			};

			return run();
		},

		lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
			const prev = lockChains.get(key) ?? Promise.resolve();
			// Don't propagate the previous chain's rejection into `fn` — each
			// caller awaits its own result independently. Subsequent locks
			// simply wait their turn regardless of prior failure.
			const next = prev.then(
				() => fn(),
				() => fn(),
			);
			// Stored chain swallows rejection so a tail-check can compare
			// against the same Promise reference we put in the Map. Identity
			// check ensures a later .lock() chained onto `next` won't be
			// clobbered by an earlier finally().
			const stored: Promise<unknown> = next.then(
				() => {
					if (lockChains.get(key) === stored) lockChains.delete(key);
				},
				() => {
					if (lockChains.get(key) === stored) lockChains.delete(key);
				},
			);
			lockChains.set(key, stored);
			return next;
		},

		tryLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
			if (lockChains.has(key)) {
				return Promise.resolve(null);
			}
			return server.lock(key, fn);
		},

		interval(ms: number, fn: () => void | Promise<void>): { clear(): void } {
			const handle = setInterval(() => {
				try {
					const result = fn();
					if (result && typeof (result as Promise<unknown>).then === "function") {
						(result as Promise<unknown>).catch((err) => {
							console.error("[reflectdb] interval error:", err);
						});
					}
				} catch (err) {
					console.error("[reflectdb] interval error:", err);
				}
			}, ms);
			activeTimers.add(handle);
			const ctrl = {
				clear() {
					clearInterval(handle);
					activeTimers.delete(handle);
				},
			};
			registerHotDispose(() => ctrl.clear());
			return ctrl;
		},

		timeout(ms: number, fn: () => void | Promise<void>): { clear(): void } {
			let done = false;
			const handle = setTimeout(() => {
				done = true;
				activeTimers.delete(handle);
				try {
					const result = fn();
					if (result && typeof (result as Promise<unknown>).then === "function") {
						(result as Promise<unknown>).catch((err) => {
							console.error("[reflectdb] timeout error:", err);
						});
					}
				} catch (err) {
					console.error("[reflectdb] timeout error:", err);
				}
			}, ms);
			activeTimers.add(handle);
			const ctrl = {
				clear() {
					if (done) return;
					clearTimeout(handle);
					activeTimers.delete(handle);
				},
			};
			registerHotDispose(() => ctrl.clear());
			return ctrl;
		},

		async close(): Promise<void> {
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			for (const t of activeTimers) {
				clearTimeout(t);
				clearInterval(t);
			}
			activeTimers.clear();
			await handler.close();
			await config.transport.close();
		},
	};

	return server;
}

function registerHotDispose(fn: () => void): void {
	// Bun's --hot reload fires `import.meta.hot.dispose`; if absent we silently
	// no-op (production / non-hot dev).
	if (typeof import.meta !== "undefined") {
		const hot = (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot;
		if (hot && typeof hot.dispose === "function") {
			hot.dispose(fn);
		}
	}
}

function parseDuration(str: string): number {
	const match = str.match(/^(\d+)(ms|s|m|h|d)$/);
	if (!match)
		throw new Error(
			`Invalid duration: "${str}". Expected format: <number><unit> (e.g., "1h", "30m", "500ms")`,
		);
	const value = Number(match[1]);
	switch (match[2]) {
		case "ms":
			return value;
		case "s":
			return value * 1000;
		case "m":
			return value * 60 * 1000;
		case "h":
			return value * 60 * 60 * 1000;
		case "d":
			return value * 24 * 60 * 60 * 1000;
		default:
			return 0;
	}
}

// Export internals for testing
export { buildRoomRegex, parseDuration };

/**
 * @internal — test-only hook to override the lazy drizzle-orm resolution.
 * Pass `null` to simulate "drizzle not installed". Pass `undefined` to reset
 * to the natural lazy-load behavior. Production code never calls this.
 */
export function __setDrizzleHelpersForTest(
	helpers: DrizzleHelpers | null | undefined,
): void {
	if (helpers === undefined) {
		drizzleHelpersPromise = undefined;
	} else {
		drizzleHelpersPromise = Promise.resolve(helpers);
	}
}
