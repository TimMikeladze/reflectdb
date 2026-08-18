import type { ServerMessage } from "../core/types.ts";
import type { AuthContext } from "../core/types.ts";
import type { ResultCache } from "./result-cache.ts";
import type { ClientSession, QuerySubscription, SessionManager } from "./session.ts";
import type { QueryRegistration } from "./handler.ts";
import type { SyncEvent } from "./types.ts";

/**
 * Deterministic JSON: object keys are emitted in sorted order at every depth.
 *
 * `JSON.stringify` is insertion-order sensitive, so two auth contexts holding
 * the same fields in a different order would hash to different group keys and
 * the broadcast engine would execute the identical query twice.
 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	const parts: string[] = [];
	for (const key of keys) {
		if (obj[key] === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${stableStringify(obj[key])}`);
	}
	return `{${parts.join(",")}}`;
}

export interface BroadcastEngineDeps<TAuth extends AuthContext> {
	sessions: SessionManager<TAuth>;
	queries: Map<string, QueryRegistration>;
	tableDependencyIndex: Map<string, Set<string>>;
	resultCache: ResultCache;
	/** Raw transport send — MUST reject when the frame did not reach the client. */
	send(clientId: string, message: ServerMessage): Promise<void>;
	/** Execute a query for a session, optionally capped to `limit` rows. */
	executeQuery(
		reg: QueryRegistration,
		session: ClientSession<TAuth>,
		limit?: number,
	): Promise<Record<string, unknown>[]>;
	/** Total row count for count hints, or null when the query has no `count` callback. */
	countQuery(reg: QueryRegistration, session: ClientSession<TAuth>): Promise<number | null>;
	/** Bump and pack the server HLC. One call per broadcast tick. */
	nextHlc(): string;
	emit(event: SyncEvent): void;
	/** Reject a query execution that exceeds this many ms. 0 disables. */
	queryTimeoutMs: number;
	/** Max query groups executed concurrently within one broadcast. */
	maxGroupConcurrency: number;
}

interface GroupMember<TAuth extends AuthContext> {
	session: ClientSession<TAuth>;
	sub: QuerySubscription;
}

/**
 * Turns "table X changed" into per-subscriber deltas.
 *
 * Subscribers are grouped by everything that can change query results
 * (auth + params + roomKey, or a query-supplied `groupBy`), the query runs once
 * per group, and each client's result cache is diffed against the shared result.
 *
 * Scaling note: one write still costs one query execution per distinct group.
 * Because `auth` is part of the default group key, groups collapse to roughly
 * one per connected client. Queries whose results depend only on a tenant/room
 * rather than the full auth object should set `groupBy` to collapse those
 * clients into a single execution.
 */
export class BroadcastEngine<TAuth extends AuthContext = AuthContext> {
	private deps: BroadcastEngineDeps<TAuth>;
	/**
	 * Per-(client, query) critical section. Inbound messages are serialized per
	 * client, but broadcasts are not: two concurrent writers would otherwise
	 * both diff against the same stale cache, both send, and both commit — last
	 * commit wins, and any row only the loser knew about never gets its delete
	 * emitted again. The client would keep a phantom row until reconnect.
	 */
	private locks = new Map<string, Promise<unknown>>();

	constructor(deps: BroadcastEngineDeps<TAuth>) {
		this.deps = deps;
	}

	private withLock<T>(clientId: string, queryName: string, fn: () => Promise<T>): Promise<T> {
		// Entries self-remove once their chain settles (identity-checked below),
		// so the map needs no per-client sweep — and never drops an in-flight
		// entry, which would let a second section run against the same cache.
		const key = `${clientId.length}:${clientId}:${queryName}`;
		const prev = this.locks.get(key) ?? Promise.resolve();
		// A prior failure must not poison the queue — each caller awaits its own
		// result, so both settle paths simply run the next critical section.
		const next = prev.then(fn, fn);
		const stored: Promise<unknown> = next.then(
			() => {
				if (this.locks.get(key) === stored) this.locks.delete(key);
			},
			() => {
				if (this.locks.get(key) === stored) this.locks.delete(key);
			},
		);
		this.locks.set(key, stored);
		return next;
	}

	private async executeWithTimeout(
		reg: QueryRegistration,
		session: ClientSession<TAuth>,
		limit?: number,
	): Promise<Record<string, unknown>[]> {
		const timeoutMs = this.deps.queryTimeoutMs;
		if (timeoutMs <= 0) return this.deps.executeQuery(reg, session, limit);

		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.deps.executeQuery(reg, session, limit),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error(
									`[reflectdb] Query "${reg.name}" exceeded queryTimeoutMs (${timeoutMs}ms)`,
								),
							),
						timeoutMs,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Forget a row the writer itself removed, in every query that depends on
	 * `tableName`.
	 *
	 * The writer is skipped by `broadcastChanges` because it applied its own op
	 * optimistically, which leaves its cached result claiming a row the client
	 * has already dropped. Re-creating that same rowId would then diff as an
	 * update against the dead row and send only the columns that differ, so the
	 * writer would never receive the server-owned columns that happen to match
	 * the row it deleted.
	 */
	forgetWriterRow(tableName: string, clientId: string, rowId: string): void {
		const affectedQueries = this.deps.tableDependencyIndex.get(tableName);
		if (!affectedQueries) return;
		for (const queryName of affectedQueries) {
			this.deps.resultCache.evictRow(clientId, queryName, rowId);
		}
	}

	/**
	 * After a write to `tableName`, re-run every dependent query and send each
	 * subscriber the rows that changed for them.
	 *
	 * @param excludeClientId — the writer, who already applied optimistically.
	 *   Pass "" for server-originated writes with no client to exclude.
	 * @param overrideRoomKey — restrict fanout to one room. `undefined` falls
	 *   back to the writer's own room; `null` broadcasts cross-room.
	 */
	async broadcastChanges(
		tableName: string,
		excludeClientId: string,
		overrideRoomKey?: string | null,
	): Promise<void> {
		const affectedQueries = this.deps.tableDependencyIndex.get(tableName);
		if (!affectedQueries) return;

		// Single HLC per broadcast: one logical state-change tick. The diff
		// produces at most one delta per rowId (insert XOR update XOR delete),
		// so same-HLC-different-rows is fine. Per-delta bumping would inflate
		// HLC churn for no correctness gain.
		const hlcStr = this.deps.nextHlc();

		for (const queryName of affectedQueries) {
			const queryReg = this.deps.queries.get(queryName);
			if (!queryReg) continue;

			const groups = this.buildGroups(queryReg, excludeClientId, overrideRoomKey);
			if (groups.length === 0) continue;

			// Groups are independent: one slow query must not stall fanout to
			// everyone else. Bounded so a large fleet can't open unlimited
			// concurrent DB queries.
			await this.runBounded(groups, (group) => this.broadcastGroup(queryReg, group, hlcStr));
		}
	}

	private buildGroups(
		queryReg: QueryRegistration,
		excludeClientId: string,
		overrideRoomKey: string | null | undefined,
	): Array<GroupMember<TAuth>[]> {
		const queryName = queryReg.name;

		// Resolve room scope. Caller-provided override wins (server-side writes
		// specify the tenant's room). Otherwise fall back to the sender's
		// subscription room. If neither is available, broadcast cross-room.
		let senderRoomKey: string | null | undefined;
		if (overrideRoomKey !== undefined) {
			senderRoomKey = overrideRoomKey;
		} else {
			const senderSession = this.deps.sessions.get(excludeClientId);
			const senderSub = senderSession?.subscriptions.get(queryName);
			senderRoomKey = senderSub ? senderSub.roomKey : undefined;
		}

		const subscribers = this.deps.sessions.getSubscribersForQuery(queryName, senderRoomKey);
		const groups = new Map<string, GroupMember<TAuth>[]>();

		for (const session of subscribers) {
			if (session.clientId === excludeClientId) continue;

			const sub = session.subscriptions.get(queryName);
			if (!sub) continue;

			// Skip windowed subscribers that haven't bootstrapped yet (their
			// cache is empty, diffing would produce spurious inserts).
			if (sub.windowSize != null && !sub.bootstrapped) continue;

			const key = this.groupKeyFor(queryReg, session, sub);
			let group = groups.get(key);
			if (!group) {
				group = [];
				groups.set(key, group);
			}
			group.push({ session, sub });
		}

		return [...groups.values()];
	}

	private groupKeyFor(
		queryReg: QueryRegistration,
		session: ClientSession<TAuth>,
		sub: QuerySubscription,
	): string {
		const custom = queryReg.options.groupBy;
		if (custom) {
			try {
				return `custom:${custom({ auth: session.auth!, params: sub.params })}|${sub.roomKey ?? ""}`;
			} catch (err) {
				// A throwing groupBy must not merge clients that shouldn't share
				// a result set — fall back to the safe per-identity key.
				console.error(
					`[reflectdb] Query "${queryReg.name}" groupBy threw; falling back to per-identity grouping:`,
					err,
				);
			}
		}
		// Everything that can change what the query returns. Stable ordering so
		// an auth object built with a different key order doesn't create a
		// duplicate group (and a duplicate query execution).
		return stableStringify({
			auth: session.auth,
			params: sub.params,
			roomKey: sub.roomKey,
		});
	}

	/**
	 * Row cap this group actually needs.
	 *
	 * Windowed subscribers only render up to their window, so fetching beyond
	 * the largest window in the group is pure waste. Returns undefined when the
	 * full result set is required — a non-windowed subscriber, or count hints
	 * without a `count` callback to compute the total cheaply.
	 */
	private limitFor(queryReg: QueryRegistration, group: GroupMember<TAuth>[]): number | undefined {
		let maxWindow = 0;
		for (const { sub } of group) {
			if (sub.windowSize == null) return undefined;
			maxWindow = Math.max(maxWindow, sub.windowLimit);
		}
		if (queryReg.options.countHints && !queryReg.options.count) return undefined;
		return maxWindow > 0 ? maxWindow : undefined;
	}

	private async broadcastGroup(
		queryReg: QueryRegistration,
		group: GroupMember<TAuth>[],
		hlcStr: string,
	): Promise<void> {
		const queryName = queryReg.name;
		// All sessions in a group share auth + params, so any of them can act as
		// the representative for query execution.
		const representative = group[0]!;
		const limit = this.limitFor(queryReg, group);

		let fullRows: Record<string, unknown>[];
		try {
			fullRows = await this.executeWithTimeout(queryReg, representative.session, limit);
		} catch (err) {
			// Query error — skip this group's broadcast to prevent ghost deletes.
			// Clients keep stale cached data until the next successful broadcast.
			console.error(
				`[reflectdb] Query "${queryName}" failed for group (client ${representative.session.clientId}), skipping broadcast:`,
				err,
			);
			this.deps.emit({
				type: "query_error",
				clientId: representative.session.clientId,
				queryName,
				phase: "broadcast",
				error: err,
			});
			return;
		}

		// Total count for windowed subscribers. Uses the query's `count`
		// callback when present (so windowing can be pushed into SQL), else the
		// length of the full result set we already had to fetch.
		let totalCount: number | null = null;
		if (queryReg.options.countHints) {
			try {
				totalCount = queryReg.options.count
					? await this.deps.countQuery(queryReg, representative.session)
					: fullRows.length;
			} catch (err) {
				console.error(`[reflectdb] Query "${queryName}" count callback failed:`, err);
			}
		}

		// Subscribers in a group are independent — their critical sections are
		// keyed per client — so fan out concurrently. Awaiting each in turn lets
		// one slow or backpressured socket delay every client behind it.
		const results = await Promise.allSettled(
			group.map(({ session, sub }) =>
				this.sendToSubscriber(queryReg, session, sub, fullRows, totalCount, hlcStr),
			),
		);
		for (let i = 0; i < results.length; i++) {
			const r = results[i]!;
			if (r.status === "rejected") {
				// Per-client error (e.g. transport send failure) — skip this subscriber.
				console.error(
					`[reflectdb] Broadcast to client ${group[i]!.session.clientId} for query "${queryName}" failed, skipping:`,
					r.reason,
				);
			}
		}
	}

	private sendToSubscriber(
		queryReg: QueryRegistration,
		session: ClientSession<TAuth>,
		sub: QuerySubscription,
		fullRows: Record<string, unknown>[],
		totalCount: number | null,
		hlcStr: string,
	): Promise<void> {
		const queryName = queryReg.name;
		const pk = queryReg.options.pk ?? "id";
		const isWindowed = sub.windowSize != null;

		// Serialize diff → send → commit per (client, query). Without this,
		// concurrent broadcasts both diff the same stale cache and the losing
		// commit's rows are never reconciled.
		return this.withLock(session.clientId, queryName, async () => {
			// Slice to what this subscriber is entitled to — its window, NOT how
			// many rows it currently holds. Slicing to `loadedCount` strands a
			// client that bootstrapped with fewer rows than its window: it would
			// sit at zero and never receive the inserts meant to fill it.
			const newRows = isWindowed ? fullRows.slice(0, sub.windowLimit) : fullRows;

			// Diff against the cached result but DON'T commit until every send
			// resolves — a dropped frame would otherwise leave the cache
			// claiming the client holds rows it never received.
			const diff = this.deps.resultCache.diffOnly(session.clientId, queryName, newRows, pk);

			const sendPromises: Promise<void>[] = [];

			for (const ins of diff.inserted) {
				sendPromises.push(
					this.deps.send(session.clientId, {
						type: "delta",
						table: queryName,
						op: "insert",
						rowId: ins.rowId,
						payload: ins.data,
						hlc: hlcStr,
					}),
				);
			}

			for (const upd of diff.updated) {
				sendPromises.push(
					this.deps.send(session.clientId, {
						type: "delta",
						table: queryName,
						op: "update",
						rowId: upd.rowId,
						payload: upd.changed,
						hlc: hlcStr,
						colClocks: Object.fromEntries(Object.keys(upd.changed).map((k) => [k, hlcStr])),
					}),
				);
			}

			for (const deletedRowId of diff.deleted) {
				sendPromises.push(
					this.deps.send(session.clientId, {
						type: "delta",
						table: queryName,
						op: "delete",
						rowId: deletedRowId,
						payload: null,
						hlc: hlcStr,
					}),
				);
			}

			let countToCommit: number | null = null;
			if (isWindowed && queryReg.options.countHints && totalCount != null) {
				if (totalCount !== sub.lastTotalCount) {
					countToCommit = totalCount;
					sendPromises.push(
						this.deps.send(session.clientId, {
							type: "count_changed",
							table: queryName,
							totalCount,
						}),
					);
				}
			}

			if (sendPromises.length === 0) {
				// Nothing changed for this client. Still commit so the cached
				// snapshot tracks the latest observed state.
				this.commit(session, queryName, newRows, pk);
				return;
			}

			await Promise.all(sendPromises);
			// Sends succeeded — commit. On failure the throw propagates and
			// leaves the cache as-was, so the next broadcast re-emits the
			// missed deltas.
			if (this.commit(session, queryName, newRows, pk) && countToCommit != null) {
				sub.lastTotalCount = countToCommit;
			}
		});
	}

	/**
	 * Commit a client's cached result set — unless it disconnected, or
	 * reconnected under the same clientId, while the sends were in flight.
	 * Writing then would resurrect the cache entry that `onDisconnect` just
	 * dropped, permanently (no further disconnect event arrives for that
	 * session), and would describe the old connection's state to a new one.
	 */
	private commit(
		session: ClientSession<TAuth>,
		queryName: string,
		rows: Record<string, unknown>[],
		pk: string,
	): boolean {
		if (this.deps.sessions.get(session.clientId) !== session) return false;
		this.deps.resultCache.set(session.clientId, queryName, rows, pk);
		return true;
	}

	/** Run `fn` over items with at most `maxGroupConcurrency` in flight. */
	private async runBounded<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
		const limit = Math.max(1, this.deps.maxGroupConcurrency);
		if (items.length === 1 || limit === 1) {
			for (const item of items) {
				try {
					await fn(item);
				} catch (err) {
					console.error("[reflectdb] broadcast group failed:", err);
				}
			}
			return;
		}

		let cursor = 0;
		const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (cursor < items.length) {
				const item = items[cursor++]!;
				try {
					await fn(item);
				} catch (err) {
					console.error("[reflectdb] broadcast group failed:", err);
				}
			}
		});
		await Promise.all(workers);
	}
}
