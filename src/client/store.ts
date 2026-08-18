import type { ClientOp, OpStatus, ErrorReason } from "../core/types.ts";
import { compareHlc } from "../core/hlc.ts";
import type { ClientStorageAdapter } from "./storage/types.ts";

export interface PendingOp {
	op: ClientOp;
	status: OpStatus;
	rejectedReason: ErrorReason | null;
	createdAt: number;
	/**
	 * Row state captured just before the optimistic apply. Restored on reject
	 * so a rejected optimistic insert collapses back to no-row (instead of
	 * leaving a tombstone), and a rejected update reverts to the merged row
	 * the client had before touching it.
	 */
	preState?: {
		data: Record<string, unknown> | null;
		colClocks: Record<string, string>;
		serverHlc: string | null;
	} | null;
}

export interface LocalRow {
	table: string;
	rowId: string;
	data: Record<string, unknown> | null;
	colClocks: Record<string, string>;
	serverHlc: string | null;
}

export class ClientStore {
	private pendingOps: PendingOp[] = [];
	private rows = new Map<string, Map<string, LocalRow>>();
	private tableMeta = new Map<
		string,
		{
			serverSet: string[];
			readonly: string[];
			broadcast: "consistent" | "eager" | "eager-durable";
			pk: string;
		}
	>();
	private storage: ClientStorageAdapter | null;
	private pendingWrites: Promise<void>[] = [];
	// Serial chain so writes commit in enqueue order. Without this, two writes
	// to the same key race in storage and the final state may be the older one.
	private writeChain: Promise<void> = Promise.resolve();

	constructor(storage?: ClientStorageAdapter) {
		this.storage = storage ?? null;
	}

	// ── Hydration ────────────────────────────────────────────────────────

	/**
	 * Load durable state into memory.
	 *
	 * @param options.tables — hydrate only these tables. Rows only ever reach
	 *   local storage through a subscription, so restoring just the tables the
	 *   client is actually subscribed to reads no less than it needs. Omit to
	 *   load every row of every table the client has ever synced.
	 */
	async hydrate(options?: { tables?: string[] }): Promise<void> {
		if (!this.storage) return;

		const storage = this.storage;
		const scoped = options?.tables;
		const [allRows, pendingOps, tableMetaJson] = await Promise.all([
			scoped
				? Promise.all(scoped.map((table) => storage.getRows(table))).then((r) => r.flat())
				: storage.getAllRows(),
			storage.getPendingOps(),
			storage.getMeta("tableMeta"),
		]);

		for (const row of allRows) {
			let tableMap = this.rows.get(row.table);
			if (!tableMap) {
				tableMap = new Map();
				this.rows.set(row.table, tableMap);
			}
			tableMap.set(row.rowId, row);
		}

		this.pendingOps = pendingOps;

		if (tableMetaJson) {
			const parsed = JSON.parse(tableMetaJson) as Record<
				string,
				{
					serverSet: string[];
					readonly: string[];
					broadcast?: "consistent" | "eager" | "eager-durable";
					pk?: string;
				}
			>;
			for (const [table, m] of Object.entries(parsed)) {
				this.tableMeta.set(table, {
					serverSet: m.serverSet,
					readonly: m.readonly,
					broadcast: m.broadcast ?? "consistent",
					pk: m.pk ?? "id",
				});
			}
		}
	}

	async flush(): Promise<void> {
		// Drain the serial chain. Resolves once every enqueued write so far
		// has settled. New writes after this call extend the chain again.
		this.pendingWrites = [];
		await this.writeChain;
	}

	private enqueue(fn: () => Promise<void>): void {
		if (!this.storage) return;
		// Chain on previous write so storage ops commit in enqueue order.
		// Catch swallows individual rejects so one failure doesn't break
		// the chain for unrelated subsequent writes.
		this.writeChain = this.writeChain.then(fn).catch((err) => {
			console.error("[reflectdb] storage write failed:", err);
		});
		this.pendingWrites.push(this.writeChain);
	}

	// ── Pending Ops ──────────────────────────────────────────────────────

	addPendingOp(op: ClientOp): void {
		// Snapshot the row state as-is so a rejection can restore it exactly.
		// `null` preState means the row didn't exist before this op.
		const existing = this.getRow(op.table, op.rowId);
		const pendingOp: PendingOp = {
			op,
			status: "pending",
			rejectedReason: null,
			createdAt: Date.now(),
			preState: existing
				? {
						data: existing.data,
						colClocks: { ...existing.colClocks },
						serverHlc: existing.serverHlc,
					}
				: null,
		};
		this.pendingOps.push(pendingOp);
		this.enqueue(() => this.storage!.appendPendingOps([pendingOp]));
	}

	getPendingOps(): PendingOp[] {
		return this.pendingOps.filter((p) => p.status === "pending");
	}

	markSynced(opIds: string[]): void {
		const idSet = new Set(opIds);
		this.pendingOps = this.pendingOps.filter((p) => !idSet.has(p.op.id));
		this.enqueue(() => this.storage!.removePendingOps(opIds));
	}

	markRejected(opId: string, reason: ErrorReason): void {
		const pending = this.pendingOps.find((p) => p.op.id === opId);
		if (pending) {
			pending.status = "rejected";
			pending.rejectedReason = reason;
			this.enqueue(() => this.storage!.updatePendingOps([pending]));
		}
		this.autoTrimRejected();
	}

	rejectBatch(batchId: string, reason: ErrorReason): void {
		const updated: PendingOp[] = [];
		for (const p of this.pendingOps) {
			if (p.op.batchId === batchId) {
				p.status = "rejected";
				p.rejectedReason = reason;
				updated.push(p);
			}
		}
		if (updated.length > 0) {
			this.enqueue(() => this.storage!.updatePendingOps(updated));
		}
		this.autoTrimRejected();
	}

	private autoTrimRejected(): void {
		// Auto-trim old rejected ops (keep last 60s for UI feedback)
		const cutoff = Date.now() - 60_000;
		const before = this.pendingOps.length;
		this.pendingOps = this.pendingOps.filter(
			(p) => p.status !== "rejected" || p.createdAt > cutoff,
		);
		if (this.pendingOps.length < before) {
			this.enqueue(() => this.storage!.putPendingOps([...this.pendingOps]));
		}
	}

	clearRejected(): void {
		this.pendingOps = this.pendingOps.filter((p) => p.status !== "rejected");
		this.enqueue(() => this.storage!.putPendingOps([...this.pendingOps]));
	}

	// ── Local Rows ───────────────────────────────────────────────────────

	setRow(
		table: string,
		rowId: string,
		data: Record<string, unknown> | null,
		colClocks: Record<string, string>,
		serverHlc: string | null,
	): void {
		if (data === null && serverHlc === null) {
			// Genuine drop (revertOp with no prior state). No tombstone to track.
			this.rows.get(table)?.delete(rowId);
			this.enqueue(() => this.storage!.deleteRow(table, rowId));
			return;
		}
		// Keep null-data rows as tombstones with their HLC so a stale insert
		// that arrives after a delete can be rejected by HLC comparison instead
		// of resurrecting the row. Persist via putRow too so the tombstone
		// survives client restart — otherwise an older insert post-reload
		// would resurrect the row anyway.
		let tableMap = this.rows.get(table);
		if (!tableMap) {
			tableMap = new Map();
			this.rows.set(table, tableMap);
		}
		const row: LocalRow = { table, rowId, data, colClocks, serverHlc };
		tableMap.set(rowId, row);
		this.enqueue(() => this.storage!.putRow(table, rowId, row));
	}

	getRow(table: string, rowId: string): LocalRow | undefined {
		const row = this.rows.get(table)?.get(rowId);
		// Hide tombstones from public reads. Tombstones live in the map
		// (with data=null) so applyDelta can compare HLCs and reject stale
		// inserts that would otherwise resurrect the row.
		if (!row || row.data === null) return undefined;
		return row;
	}

	/** Internal: includes tombstones for HLC comparison in applyDelta. */
	private getRowEntry(table: string, rowId: string): LocalRow | undefined {
		return this.rows.get(table)?.get(rowId);
	}

	getRows(table: string, includeDeleted = false): LocalRow[] {
		const tableMap = this.rows.get(table);
		if (!tableMap) return [];

		const result: LocalRow[] = [];
		for (const row of tableMap.values()) {
			if (row.data !== null) {
				// Auto-filter soft-deleted rows (design decision #7)
				// Support both camelCase (drizzle JS names) and snake_case (SQL column names)
				if (!includeDeleted && (row.data.deletedAt != null || row.data.deleted_at != null)) {
					continue;
				}
				result.push(row);
			}
		}
		return result;
	}

	clearTable(table: string): void {
		this.rows.delete(table);
		this.enqueue(() => this.storage!.clearTable(table));
	}

	// ── Apply Server State ──────────────────────────────────────────────

	applySnapshot(
		table: string,
		rows: Record<string, unknown>[],
		colClocks: Record<string, Record<string, string>>,
		append = false,
		pk?: string,
	): void {
		if (!append) {
			this.clearTable(table);
		}
		// Lookup order: explicit pk from snapshot message > tableMeta > "id".
		// The snapshot carries its own pk so applySnapshot doesn't depend on
		// bootstrap_complete having set tableMeta first.
		const effectivePk = pk ?? this.tableMeta.get(table)?.pk ?? "id";
		for (const row of rows) {
			const rowId = (row[effectivePk] as string) ?? "";
			const clocks = colClocks[rowId] ?? {};
			this.setRow(table, rowId, row, clocks, clocks._row ?? null);
		}

		// Re-apply pending optimistic ops for this table so a snapshot landing
		// while the user has unacked writes doesn't visually wipe their input.
		// Server's response (ack/reject) eventually reconciles authoritative state.
		for (const p of this.pendingOps) {
			if (p.status === "pending" && p.op.table === table) {
				this.applyOptimistic(p.op);
			}
		}
	}

	applyDelta(
		table: string,
		op: string,
		rowId: string,
		payload: Record<string, unknown> | null,
		hlc: string,
		colClocks?: Record<string, string>,
	): void {
		// Use the internal accessor so a tombstone (data=null with serverHlc)
		// blocks resurrection by an older insert.
		const existing = this.getRowEntry(table, rowId);

		// Causal ordering: out-of-order delta delivery (transport reorder, polling)
		// can land an older HLC after a newer one. Reject (or merge per-column)
		// so older state can't overwrite newer.
		if (op === "delete") {
			if (existing?.serverHlc && compareHlc(hlc, existing.serverHlc) <= 0) {
				return; // stale delete, ignore
			}
			this.setRow(table, rowId, null, {}, hlc);
			return;
		}

		if (op === "insert" || !existing) {
			// Insert against existing row: only apply if strictly newer
			if (existing?.serverHlc && compareHlc(hlc, existing.serverHlc) <= 0) {
				return;
			}
			this.setRow(
				table,
				rowId,
				this.withPk(table, rowId, payload ?? {}),
				colClocks ?? { _row: hlc },
				hlc,
			);
			return;
		}

		// Update: merge per-column with HLC comparison so a stale-overall delta
		// can still apply newer columns and a newer-overall delta can't be
		// reverted by a later out-of-order older delta.
		const incomingClocks = colClocks ?? {};
		const mergedData: Record<string, unknown> = { ...existing.data };
		const mergedClocks: Record<string, string> = { ...existing.colClocks };
		let anyApplied = false;

		for (const [col, value] of Object.entries(payload ?? {})) {
			const incomingClock = incomingClocks[col] ?? hlc;
			const existingClock = existing.colClocks[col];
			if (!existingClock || compareHlc(incomingClock, existingClock) > 0) {
				mergedData[col] = value;
				mergedClocks[col] = incomingClock;
				anyApplied = true;
			}
		}

		if (!anyApplied) {
			return; // entirely stale delta, drop
		}

		// Advance _row to the highest applied col clock (or message hlc if newer)
		const newRowHlc =
			existing.serverHlc && compareHlc(existing.serverHlc, hlc) >= 0 ? existing.serverHlc : hlc;
		mergedClocks._row = newRowHlc;
		this.setRow(table, rowId, this.withPk(table, rowId, mergedData), mergedClocks, newRowHlc);
	}

	/**
	 * Guarantee a materialized row carries its own primary key.
	 *
	 * A delta's payload is not always a whole row: eager broadcasts forward the
	 * writer's payload verbatim, and the typed API omits the pk from what a
	 * client may write — so an eagerly-broadcast insert describes a row with no
	 * id in it. Rows are addressed by `rowId` everywhere in the protocol, so the
	 * key is never in doubt; only the materialized object was missing it, and
	 * `rows.map(r => r.id)` came back undefined.
	 */
	private withPk(
		table: string,
		rowId: string,
		data: Record<string, unknown>,
	): Record<string, unknown> {
		const pk = this.tableMeta.get(table)?.pk ?? "id";
		if (data[pk] !== undefined) return data;
		return { ...data, [pk]: rowId };
	}

	// Revert a rejected op — server state wins (design decision #3).
	// If the server echoed a row, use it. Otherwise fall back to the pre-op
	// snapshot so an optimistic insert reverts to no-row instead of leaving
	// a tombstone (which previously shadowed future reads via includeDeleted).
	revertOp(opId: string, serverRow: Record<string, unknown> | null | undefined): void {
		const pending = this.pendingOps.find((p) => p.op.id === opId);
		if (!pending) return;

		const { table, rowId } = pending.op;

		if (serverRow != null) {
			const existing = this.getRow(table, rowId);
			this.setRow(table, rowId, serverRow, existing?.colClocks ?? {}, existing?.serverHlc ?? null);
		} else if (pending.preState) {
			this.setRow(
				table,
				rowId,
				pending.preState.data,
				pending.preState.colClocks,
				pending.preState.serverHlc,
			);
		} else {
			// No prior row and server didn't send one — drop entirely.
			const tableMap = this.rows.get(table);
			if (tableMap) {
				tableMap.delete(rowId);
				this.enqueue(() => this.storage!.deleteRow(table, rowId));
			}
		}

		this.pendingOps = this.pendingOps.filter((p) => p.op.id !== opId);
		this.enqueue(() => this.storage!.removePendingOps([opId]));
	}

	// ── Table Meta ──────────────────────────────────────────────────────

	setTableMeta(
		meta: Record<
			string,
			{
				serverSet: string[];
				readonly: string[];
				broadcast?: "consistent" | "eager" | "eager-durable";
				pk?: string;
			}
		>,
	): void {
		for (const [table, m] of Object.entries(meta)) {
			this.tableMeta.set(table, {
				serverSet: m.serverSet,
				readonly: m.readonly,
				broadcast: m.broadcast ?? "consistent",
				pk: m.pk ?? "id",
			});
		}
		this.enqueue(() =>
			this.storage!.setMeta("tableMeta", JSON.stringify(Object.fromEntries(this.tableMeta))),
		);
	}

	getTableMeta(table: string):
		| {
				serverSet: string[];
				readonly: string[];
				broadcast: "consistent" | "eager" | "eager-durable";
				pk: string;
		  }
		| undefined {
		return this.tableMeta.get(table);
	}

	// ── Optimistic Apply ────────────────────────────────────────────────

	applyOptimistic(op: ClientOp): void {
		const meta = this.tableMeta.get(op.table);
		let payload = op.payload;

		// Strip serverSet fields from local materialization (design decision #4)
		if (payload && meta?.serverSet.length) {
			payload = { ...payload };
			for (const field of meta.serverSet) {
				delete payload[field];
			}
		}

		// Materialize the primary key from the op's rowId — see `withPk`.
		if (op.op === "insert" && payload) {
			payload = this.withPk(op.table, op.rowId, payload);
		}

		if (op.op === "delete") {
			// Tombstone with op.hlc so a stale broadcast insert can't resurrect
			// the row before our delete is acked. Without the HLC, setRow's
			// "genuine drop" branch fires and applyDelta then sees no `existing`
			// and applies the stale insert.
			this.setRow(op.table, op.rowId, null, { _row: op.hlc }, op.hlc);
		} else if (op.op === "insert") {
			// Merge over a row that already exists rather than replacing it.
			// An insert whose row is already here is an insert the server will
			// resolve as a column-wise merge anyway — and replacing would drop
			// every server-owned column the client never writes. That is not
			// hypothetical: `applySnapshot` replays pending ops, so a snapshot
			// landing while an insert is unacked would otherwise reduce the
			// authoritative row to the payload the client sent, with no later
			// delta to restore the rest (the server believes the client still
			// holds the row it sent).
			const existing = this.getRow(op.table, op.rowId);
			if (existing?.data) {
				// Same shape as the update branch, including the row's server
				// clock: an optimistic write must not advance the watermark the
				// server's next delta is compared against.
				const merged = { ...existing.data, ...payload };
				this.setRow(op.table, op.rowId, merged, existing.colClocks, existing.serverHlc);
			} else {
				this.setRow(op.table, op.rowId, payload ?? {}, { _row: op.hlc }, op.hlc);
			}
		} else {
			const existing = this.getRow(op.table, op.rowId);
			if (existing?.data) {
				const merged = { ...existing.data, ...payload };
				this.setRow(op.table, op.rowId, merged, existing.colClocks, existing.serverHlc);
			}
		}
	}

	// ── Full Reset ──────────────────────────────────────────────────────

	async clear(): Promise<void> {
		// Drain in-flight writes BEFORE clearing storage. Otherwise an in-flight
		// putRow could land after storage.clear and resurrect rows we just wiped.
		try {
			await this.writeChain;
		} catch {
			// individual write errors already logged by enqueue's catch
		}
		this.rows.clear();
		this.pendingOps = [];
		this.tableMeta.clear();
		this.pendingWrites = [];
		// Fresh chain so post-clear writes don't queue behind aborted pre-clear ones
		this.writeChain = Promise.resolve();
		if (this.storage) {
			await this.storage.clear();
		}
	}
}
