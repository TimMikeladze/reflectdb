import type { AuthContext, ClientOp, ErrorReason, OpType, ServerMessage } from "../core/types.ts";
import { reasonFromError } from "../core/types.ts";
import type { ExistingRow } from "./conflict.ts";
import {
	enforceBatchSize,
	enforceClockDrift,
	enforceReadonly,
	enforceServerSet,
} from "./enforcement.ts";
import type { RateLimiter } from "./enforcement.ts";
import type { EagerBuffer } from "./eager-buffer.ts";
import type { QueryRegistration, StorageAdapter } from "./handler.ts";
import { processOp } from "./pipeline.ts";
import type { PipelineContext } from "./pipeline.ts";
import type { ReplayDetector } from "./replay-detector.ts";
import type { ClientSession, SessionManager } from "./session.ts";
import type { AuthorizeAction, MutateResult, MutationContext, ResolvedOp } from "./types.ts";

/**
 * Per-`ops`-message state shared by every op in the batch: which op ids were
 * fresh (one replay reservation for the whole batch) and the rows those ops
 * touch (one read per table). Kept write-through so an op later in the batch
 * still sees the state an earlier op in the same batch wrote.
 */
export interface BatchContext {
	freshOpIds: Set<string>;
	rows: Map<string, ExistingRow>;
}

export interface OpResult {
	accepted: boolean;
	reason?: ErrorReason;
	serverRow?: Record<string, unknown> | null;
}

/**
 * Collaborators the op pipeline needs from the handler. Mutable settings are
 * read through getters because `setStorage`/`setRateLimiter`/`setMaxBatchSize`
 * can land after the processor is constructed.
 */
export interface OpProcessorDeps<TAuth extends AuthContext> {
	db: unknown;
	queries: Map<string, QueryRegistration>;
	sessions: SessionManager<TAuth>;
	eagerBuffer: EagerBuffer;
	replay: ReplayDetector;
	getStorage(): StorageAdapter | null;
	getRateLimiter(): RateLimiter | null;
	getMaxBatchSize(): number;
	/** Bump the server clock and return the packed HLC. */
	stampHlc(): string;
	/** Advance the server clock past an accepted client op's HLC. */
	receiveClientHlc(hlc: string): void;
	send(clientId: string, message: ServerMessage): Promise<void>;
	broadcastChanges(tableName: string, excludeClientId: string): Promise<void>;
	/**
	 * Drop a row the writer deleted from the writer's own cached result set.
	 * The writer is excluded from the broadcast of its own op, so without this
	 * the cache keeps a row the client no longer holds — and a later re-insert
	 * of the same rowId diffs as a partial update against that dead row.
	 */
	forgetWriterRow(tableName: string, clientId: string, rowId: string): void;
}

/**
 * Applies client ops: replay reservation, enforcement, conflict resolution,
 * persistence and the eager-path delta fanout.
 *
 * Two pipelines live here. The **consistent** path runs the full conflict
 * pipeline, persists, then lets the broadcast engine diff each subscriber's
 * query result. The **eager** paths skip conflict resolution and send the delta
 * straight to subscribers — they still run every enforcement gate.
 */
export class OpProcessor<TAuth extends AuthContext = AuthContext> {
	private deps: OpProcessorDeps<TAuth>;

	constructor(deps: OpProcessorDeps<TAuth>) {
		this.deps = deps;
	}

	// Mutable handler settings, read fresh on every access.
	private get storage(): StorageAdapter | null {
		return this.deps.getStorage();
	}
	private get rateLimiter(): RateLimiter | null {
		return this.deps.getRateLimiter();
	}
	private get maxBatchSize(): number {
		return this.deps.getMaxBatchSize();
	}
	private get db(): unknown {
		return this.deps.db;
	}
	private get queries(): Map<string, QueryRegistration> {
		return this.deps.queries;
	}
	private get sessions(): SessionManager<TAuth> {
		return this.deps.sessions;
	}
	private get eagerBuffer(): EagerBuffer {
		return this.deps.eagerBuffer;
	}
	private get replay(): ReplayDetector {
		return this.deps.replay;
	}

	private static rowKey(table: string, rowId: string): string {
		return `${table.length}:${table}:${rowId}`;
	}

	/**
	 * Reserve every op id and read every touched row in as few round trips as
	 * the adapter allows. Falls back to per-op calls on adapters without the
	 * batch methods, in which case the returned context only carries the
	 * reservation result.
	 */
	async prefetchBatch(ops: ClientOp[]): Promise<BatchContext> {
		const freshOpIds = new Set<string>();
		const rows = new Map<string, ExistingRow>();

		// Only ops that can actually be applied get reserved. Reserving one that
		// `processClientOp` rejects before its replay check — unknown query, or
		// a query with no mutate — would burn the op id: a later retry against a
		// fixed server is then mistaken for a replay and silently acked.
		const reservable = ops.filter((op) => {
			const reg = this.queries.get(op.table);
			return reg != null && reg.options.mutate != null;
		});

		if (this.storage?.reserveOps) {
			for (const id of await this.storage.reserveOps(reservable.map((o) => o.id))) {
				freshOpIds.add(id);
			}
		} else {
			for (const op of reservable) {
				if (await this.replay.reserve(op.id)) freshOpIds.add(op.id);
			}
		}

		if (this.storage?.getRowsByIds) {
			// Group by table so each table costs one query, not one per row.
			const byTable = new Map<string, Set<string>>();
			for (const op of ops) {
				if (!freshOpIds.has(op.id)) continue;
				let ids = byTable.get(op.table);
				if (!ids) {
					ids = new Set();
					byTable.set(op.table, ids);
				}
				ids.add(op.rowId);
			}
			const reads = [...byTable].map(async ([table, ids]) => {
				const found = await this.storage!.getRowsByIds!(table, [...ids]);
				for (const rowId of ids) {
					rows.set(
						OpProcessor.rowKey(table, rowId),
						found[rowId] ?? { row: null, rowHlc: null, colClocks: {} },
					);
				}
			});
			const results = await Promise.allSettled(reads);
			for (const r of results) {
				if (r.status === "rejected") {
					// Fall back to per-op reads for the affected table.
					console.warn("[reflectdb] batch row prefetch failed, falling back to getRow:", r.reason);
				}
			}
		}

		return { freshOpIds, rows };
	}

	/** Read a row, preferring the batch prefetch cache. */
	private async readRow(
		table: string,
		rowId: string,
		batchCtx?: BatchContext,
	): Promise<ExistingRow> {
		const cached = batchCtx?.rows.get(OpProcessor.rowKey(table, rowId));
		if (cached) return cached;
		if (!this.storage) return { row: null, rowHlc: null, colClocks: {} };
		const existing = await this.storage.getRow(table, rowId);
		batchCtx?.rows.set(OpProcessor.rowKey(table, rowId), existing);
		return existing;
	}

	/**
	 * Write-through the batch cache after a successful apply, so a later op in
	 * the same batch touching the same row conflict-resolves against what was
	 * just written rather than the pre-batch snapshot.
	 */
	private recordBatchWrite(
		batchCtx: BatchContext | undefined,
		table: string,
		rowId: string,
		row: Record<string, unknown> | null,
		colClocks: Record<string, string>,
		hlc: string,
	): void {
		batchCtx?.rows.set(OpProcessor.rowKey(table, rowId), {
			row,
			rowHlc: hlc,
			colClocks,
		});
	}

	async processClientOp(
		op: ClientOp,
		session: ClientSession<TAuth>,
		deferredBroadcastTables?: Set<string>,
		batchCtx?: BatchContext,
	): Promise<OpResult> {
		// Look up query registration by the op's table field (which is the query name)
		const queryReg = this.queries.get(op.table);
		if (!queryReg) {
			return { accepted: false, reason: "outside_shape" };
		}

		// Reject writes to read-only queries (no mutate callback)
		if (!queryReg.options.mutate) {
			return { accepted: false, reason: "readonly_query" };
		}

		// Atomic replay detection — single CAS prevents HA double-apply.
		// Already reserved for the whole batch when a batch context is present;
		// `delete` consumes the reservation so a batch that repeats an op id
		// applies it once, exactly as one-reserve-per-op would.
		const fresh = batchCtx ? batchCtx.freshOpIds.delete(op.id) : await this.replay.reserve(op.id);
		if (!fresh) {
			return { accepted: true }; // Silently accept — idempotent
		}

		this.deps.receiveClientHlc(op.hlc);

		// ── Eager broadcast path: skip pipeline, broadcast immediately, defer persistence ──
		// (eager-durable persists synchronously inside processEagerOp before broadcast)
		if (queryReg.options.broadcast === "eager" || queryReg.options.broadcast === "eager-durable") {
			// A mixed batch defers consistent-path broadcasts to the end but the
			// eager path sends inline, which would emit this op's delta ahead of
			// deltas for ops that were accepted earlier in the same batch. Flush
			// the pending consistent broadcasts first so subscribers observe the
			// batch in submission order.
			if (deferredBroadcastTables && deferredBroadcastTables.size > 0) {
				const pending = [...deferredBroadcastTables];
				deferredBroadcastTables.clear();
				for (const table of pending) {
					await this.deps.broadcastChanges(table, session.clientId);
				}
			}
			return this.processEagerOp(op, queryReg, session, batchCtx);
		}

		// ── Consistent path (default): full pipeline → persist → broadcast via change detection ──
		return this.processConsistentOp(op, queryReg, session, deferredBroadcastTables, batchCtx);
	}

	private async processEagerOp(
		op: ClientOp,
		queryReg: QueryRegistration,
		session: ClientSession<TAuth>,
		batchCtx?: BatchContext,
	): Promise<OpResult> {
		// ── Enforcement gates ────────────────────────────────────────────
		// Eager skips conflict resolution (that IS the latency win) but must
		// NOT skip the security gates: without them a client can write fields
		// the schema declares server-controlled, or bypass the batch cap.

		const drift = enforceClockDrift(op.hlc);
		if (!drift.ok) {
			return { accepted: false, reason: drift.reason };
		}

		const batch = enforceBatchSize(op.batchSize, this.maxBatchSize);
		if (!batch.ok) {
			return { accepted: false, reason: batch.reason };
		}

		// Rate limiting (shared budget with consistent path) — now also
		// checks per-table bucket if configured.
		if (this.rateLimiter) {
			try {
				const result = this.rateLimiter.check(session.auth!.userId, session.clientId, op.table);
				if (!result.ok) {
					return { accepted: false, reason: "rate_limited" };
				}
				this.rateLimiter.record(session.auth!.userId, session.clientId, op.table);
			} catch (err) {
				// Fail-open: a buggy rate limiter shouldn't crash the handler
				console.error("[reflectdb] Rate limiter error (fail-open):", err);
			}
		}

		// Strip readonly fields and inject serverSet, exactly as the consistent
		// pipeline does. serverSet functions are resolved against the mutation
		// context first.
		const enforceSub = session.subscriptions.get(op.table);
		let enforcedOptions = queryReg.options;
		if (enforcedOptions.serverSet && Object.keys(enforcedOptions.serverSet).length > 0) {
			const serverSetCtx = { auth: session.auth!, params: enforceSub?.params ?? {} };
			const resolvedServerSet: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(enforcedOptions.serverSet)) {
				resolvedServerSet[key] =
					typeof value === "function" ? (value as (ctx: unknown) => unknown)(serverSetCtx) : value;
			}
			enforcedOptions = { ...enforcedOptions, serverSet: resolvedServerSet };
		}
		op = enforceServerSet(enforceReadonly(op, enforcedOptions), enforcedOptions);

		// Assign server HLC for monotonic ordering
		const hlcStr = this.deps.stampHlc();

		const payload = op.payload;
		// For UPDATE on eager path, merge payload over the existing row before
		// persistence — putRow/applyOp does INSERT OR REPLACE, so passing the
		// raw partial payload as `row` would wipe unchanged columns. Eager
		// bypasses the conflict pipeline (which normally handles this merge).
		let mergedRow: Record<string, unknown> | null = payload;
		const colClocks: Record<string, string> = {};
		if (payload) {
			for (const key of Object.keys(payload)) {
				colClocks[key] = hlcStr;
			}
		}
		colClocks._row = hlcStr;

		if (op.op === "update" && payload && this.storage) {
			try {
				const existing = await this.readRow(op.table, op.rowId, batchCtx);
				if (existing.row) {
					mergedRow = { ...existing.row, ...payload };
					// Preserve clocks for untouched cols so a later partial update
					// can still use per-column HLC for ordering.
					const merged: Record<string, string> = { ...existing.colClocks };
					for (const k of Object.keys(payload)) merged[k] = hlcStr;
					merged._row = hlcStr;
					Object.assign(colClocks, merged);
				}
			} catch (err) {
				console.error("[reflectdb] eager update: getRow failed, applying payload as-is:", err);
			}
		}

		// Build ResolvedOp
		const resolvedOp: ResolvedOp = {
			type: op.op,
			table: op.table,
			rowId: op.rowId,
			payload,
			hlc: hlcStr,
		};

		// Build MutationContext
		const sub = session.subscriptions.get(op.table);
		const mutCtx: MutationContext = {
			auth: session.auth!,
			params: sub?.params ?? {},
		};

		// Authorize write access
		if (queryReg.options.authorize) {
			try {
				await (
					queryReg.options.authorize as (
						action: AuthorizeAction,
						ctx: MutationContext,
						db: unknown,
					) => Promise<void>
				)({ type: "write", table: op.table, op: resolvedOp }, mutCtx, this.db);
			} catch (err) {
				const reason = reasonFromError(err);
				return { accepted: false, reason };
			}
		}

		// Check buffer capacity BEFORE mutate to avoid rejecting after user's DB commit
		// Oplog payload = original delta; row = merged result for putRow safety.
		const bufferEntry = {
			entry: {
				table: op.table,
				op: op.op,
				rowId: op.rowId,
				payload,
				hlc: hlcStr,
				colClocks,
			},
			row: mergedRow,
		};
		if (!this.eagerBuffer.hasCapacity(op.table, queryReg.options.maxBufferSize)) {
			return { accepted: false, reason: "buffer_full" };
		}

		// Call mutate — reject on throw
		let mutateResult: MutateResult | undefined;
		if (queryReg.options.mutate) {
			try {
				const result = await (
					queryReg.options.mutate as (
						op: ResolvedOp,
						ctx: MutationContext,
						db: unknown,
					) => Promise<void | MutateResult>
				)(resolvedOp, mutCtx, this.db);
				if (result) mutateResult = result;
			} catch (err) {
				const reason = reasonFromError(err);
				return { accepted: false, reason };
			}
		}

		// Durable variant: persist atomically BEFORE broadcast so a crash
		// can't leave subscribers with an op the server doesn't remember.
		// Standard eager mode pushes to the buffer and flushes lazily.
		if (queryReg.options.broadcast === "eager-durable" && this.storage) {
			await this.storage.applyOp!(op.table, op.rowId, mergedRow, colClocks, hlcStr, op.op, payload);
			this.recordBatchWrite(batchCtx, op.table, op.rowId, mergedRow, colClocks, hlcStr);
		} else if (!this.storage) {
			// Nothing to persist: the op log is disabled entirely. Buffering here
			// would fill a buffer that is never drained — and once it hit
			// maxBufferSize every subsequent write would be rejected `buffer_full`.
			this.recordBatchWrite(batchCtx, op.table, op.rowId, mergedRow, colClocks, hlcStr);
		} else {
			// Push to buffer for deferred persistence (capacity already checked).
			// If push fails because the buffer filled while mutate awaited, fall
			// back to atomic synchronous persistence so the op log doesn't drop
			// a write the user DB already committed.
			const pushed = this.eagerBuffer.push(op.table, bufferEntry, queryReg.options.maxBufferSize);
			this.recordBatchWrite(batchCtx, op.table, op.rowId, mergedRow, colClocks, hlcStr);
			if (!pushed && this.storage) {
				try {
					await this.storage.applyOp!(
						op.table,
						op.rowId,
						mergedRow,
						colClocks,
						hlcStr,
						op.op,
						payload,
					);
				} catch (err) {
					console.error("[reflectdb] eager fallback applyOp after buffer overflow failed:", err);
				}
			}
		}

		// The writer applied this delete optimistically and is skipped by the
		// fanout below, so its cached result has to forget the row here or a
		// later re-insert of the same rowId diffs against a row that is gone.
		if (op.op === "delete") {
			this.deps.forgetWriterRow(op.table, session.clientId, op.rowId);
		}

		// Broadcast delta directly to subscribers (skip result cache diffing)
		const senderSession = this.sessions.get(session.clientId);
		const senderSub = senderSession?.subscriptions.get(op.table);
		const senderRoomKey = senderSub ? senderSub.roomKey : undefined;
		const subscribers = this.sessions.getSubscribersForQuery(op.table, senderRoomKey);

		const eagerSendPromises: Promise<void>[] = [];
		for (const sub of subscribers) {
			if (sub.clientId === session.clientId) continue;

			eagerSendPromises.push(
				this.deps.send(sub.clientId, {
					type: "delta",
					table: op.table,
					op: op.op as OpType,
					rowId: op.rowId,
					payload,
					hlc: hlcStr,
					colClocks,
				}),
			);
		}
		// allSettled: a single failing subscriber must not abort the broadcast
		// to the rest. Per-client send errors land in the transport layer's
		// own retry/cleanup path.
		const eagerResults = await Promise.allSettled(eagerSendPromises);
		for (const r of eagerResults) {
			if (r.status === "rejected") {
				console.error("[reflectdb] eager broadcast send failed:", r.reason);
			}
		}

		// Broadcast affected tables from MutateResult
		if (mutateResult?.affected) {
			for (const affectedTable of mutateResult.affected) {
				await this.deps.broadcastChanges(affectedTable, session.clientId);
			}
		}

		return { accepted: true };
	}

	private async processConsistentOp(
		op: ClientOp,
		queryReg: QueryRegistration,
		session: ClientSession<TAuth>,
		deferredBroadcastTables?: Set<string>,
		batchCtx?: BatchContext,
	): Promise<OpResult> {
		let options = queryReg.options;

		// Resolve serverSet functions with mutation context before pipeline
		if (options.serverSet && Object.keys(options.serverSet).length > 0) {
			const sub = session.subscriptions.get(op.table);
			const mutCtx = { auth: session.auth!, params: sub?.params ?? {} };
			const resolvedServerSet: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(options.serverSet)) {
				resolvedServerSet[key] =
					typeof value === "function" ? (value as (ctx: unknown) => unknown)(mutCtx) : value;
			}
			options = { ...options, serverSet: resolvedServerSet };
		}

		// Get existing row from storage
		let existing: ExistingRow = { row: null, rowHlc: null, colClocks: {} };
		if (this.storage) {
			existing = await this.readRow(op.table, op.rowId, batchCtx);
		}

		const ctx: PipelineContext = {
			userId: session.auth!.userId,
			nodeId: session.clientId,
			options,
			conflict: options.conflict ?? "lww",
			rateLimiter: this.rateLimiter ?? undefined,
			maxBatchSize: this.maxBatchSize,
		};

		const result = processOp(op, existing, ctx);

		if (result.accepted) {
			// Build ResolvedOp from pipeline result
			const resolvedOp: ResolvedOp = {
				type: op.op,
				table: op.table,
				rowId: op.rowId,
				payload: result.resolvedRow,
				hlc: op.hlc,
			};

			// Build MutationContext
			const sub = session.subscriptions.get(op.table);
			const mutCtx: MutationContext = {
				auth: session.auth!,
				params: sub?.params ?? {},
			};

			// Authorize write access
			if (queryReg.options.authorize) {
				try {
					await (
						queryReg.options.authorize as (
							action: AuthorizeAction,
							ctx: MutationContext,
							db: unknown,
						) => Promise<void>
					)({ type: "write", table: op.table, op: resolvedOp }, mutCtx, this.db);
				} catch (err) {
					const reason = reasonFromError(err);
					return { accepted: false, reason, serverRow: existing.row };
				}
			}

			// Call mutate — reject on throw. Guard against missing mutate so a
			// query without one is a no-op write through the sync layer rather
			// than a TypeError caught as generic server_error.
			let mutateResult: void | MutateResult = undefined;
			if (queryReg.options.mutate) {
				try {
					mutateResult = await (
						queryReg.options.mutate as (
							op: ResolvedOp,
							ctx: MutationContext,
							db: unknown,
						) => Promise<void | MutateResult>
					)(resolvedOp, mutCtx, this.db);
				} catch (err) {
					const reason = reasonFromError(err);
					return { accepted: false, reason, serverRow: existing.row };
				}
			}

			// Write to sync storage AFTER mutate succeeds. Atomic via applyOp —
			// non-atomic adapters get a documented warning + shim in setStorage.
			if (this.storage) {
				await this.storage.applyOp!(
					op.table,
					op.rowId,
					result.resolvedRow,
					result.updatedColClocks,
					op.hlc,
					op.op,
					result.resolvedRow,
				);
				this.recordBatchWrite(
					batchCtx,
					op.table,
					op.rowId,
					result.resolvedRow,
					result.updatedColClocks,
					op.hlc,
				);
			}

			// The client already dropped this row optimistically; its cached
			// result must drop it too, or re-creating the same rowId later
			// diffs as an update against the row that no longer exists.
			if (op.op === "delete") {
				this.deps.forgetWriterRow(op.table, session.clientId, op.rowId);
			}

			// Collect affected tables for deferred broadcast (batch path) or broadcast immediately
			if (deferredBroadcastTables) {
				deferredBroadcastTables.add(op.table);
				if (mutateResult?.affected) {
					for (const affectedTable of mutateResult.affected) {
						deferredBroadcastTables.add(affectedTable);
					}
				}
			} else {
				// Deduplicate: op.table may also appear in mutateResult.affected
				const tablesToBroadcast = new Set<string>([op.table]);
				if (mutateResult?.affected) {
					for (const affectedTable of mutateResult.affected) {
						tablesToBroadcast.add(affectedTable);
					}
				}
				for (const table of tablesToBroadcast) {
					await this.deps.broadcastChanges(table, session.clientId);
				}
			}
		}

		return {
			accepted: result.accepted,
			reason: result.reason,
			serverRow: result.accepted ? undefined : existing.row,
		};
	}
}
