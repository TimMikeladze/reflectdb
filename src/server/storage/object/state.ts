/**
 * In-memory authoritative room state for the object-storage backend.
 *
 * The object store is durability, never the read path (docs/object-storage.md).
 * Every read — `getRow`, `getRows`, `getOpsSince`, `reserveOp` — is answered
 * from these structures with no network round trip, which is what makes this
 * adapter faster than the SQLite one rather than slower than it. The store only
 * ever sees writes, and only in batches.
 *
 * Nothing here touches the driver. That separation is deliberate: state is
 * synchronous and total, so `wal.ts` can treat a memory mutation plus a buffer
 * append as one uninterruptible unit without needing a transaction.
 */

import type { ExistingRow } from "../../conflict.ts";
import type { OpLogEntry } from "../../handler.ts";
import { MemoryLimitExceededError } from "./types.ts";
import type { MemoryConfig, MemoryPolicy, SnapshotRecord, SnapshotRow } from "./types.ts";

// ── clock ─────────────────────────────────────────────────────────────────

/**
 * Every wall-clock read and every timer in this directory goes through a
 * `Clock`. Lease expiry, op-id retention and flush backoff are all time-driven,
 * and a test that has to `await delay(300_000)` to prove a lease lapsed is a
 * test nobody runs. Injecting the clock keeps those paths deterministic.
 */
export interface Clock {
	now(): number;
	delay(ms: number): Promise<void>;
	/** Schedules `fn` and returns a cancel function. */
	setTimer(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	delay: (ms) =>
		new Promise((resolve) => {
			unref(setTimeout(resolve, ms));
		}),
	setTimer: (fn, ms) => {
		const id = setTimeout(fn, ms);
		unref(id);
		return () => {
			clearTimeout(id);
		};
	},
};

/**
 * Detaches a timer from the event loop's liveness.
 *
 * An idle room under `lease.mode: "on-write"` should cost nothing, and a live
 * renew timer — or a shutdown-flush deadline that outlives the flush — would
 * still pin the process open: a script that opened a room would hang on exit
 * instead of returning. `unref` is a Node/Bun extension and is absent in a
 * browser, where no timer keeps anything alive anyway.
 */
function unref(id: unknown): void {
	(id as { unref?: () => void }).unref?.();
}

// ── memory budget ─────────────────────────────────────────────────────────

/**
 * Process-wide byte budget shared by every room.
 *
 * The budget is global rather than per-room because a per-room cap lets one
 * whale room starve five hundred small ones: each stays under its own limit
 * while the process as a whole runs out of heap. `maxRoomBytes` still exists as
 * a blast-radius guard, but `maxTotalBytes` is the one that maps to the machine.
 */
export class ProcessMemoryBudget {
	private limitBytes = Number.POSITIVE_INFINITY;
	private usedBytes = 0;

	get used(): number {
		return this.usedBytes;
	}

	get limit(): number {
		return this.limitBytes;
	}

	/**
	 * Narrows the process budget. The tightest configuration wins: two rooms
	 * built with different `maxTotalBytes` values describe the same heap, and
	 * honoring the looser one would silently discard the stricter operator's
	 * intent.
	 */
	constrain(limit: number): void {
		if (limit < this.limitBytes) this.limitBytes = limit;
	}

	add(delta: number): void {
		this.usedBytes += delta;
		// Accounting is approximate (see `approxBytes`), so rounding can drift
		// below zero across a long-lived process. Clamp rather than let the drift
		// accumulate into a budget that can never be exceeded.
		if (this.usedBytes < 0) this.usedBytes = 0;
	}
}

/**
 * The default budget, shared by every room in the process. Tests pass their own
 * so one suite's accounting cannot leak into the next.
 */
export const processMemoryBudget: ProcessMemoryBudget = new ProcessMemoryBudget();

/**
 * Approximate byte size of a JSON-serializable value.
 *
 * `JSON.stringify(...).length` at mutation time, deliberately, rather than an
 * exact heap measurement: it is O(size of the changed value) instead of O(size
 * of the state), so the cost lands on the write that caused the growth and
 * never on a periodic scan. It undercounts JS object overhead and counts UTF-16
 * units rather than bytes, which is fine — the budget exists to turn an OOM
 * into a typed error, and an estimate that tracks within a small constant
 * factor does that job. An exact accounting would cost more than the limit it
 * protects.
 */
function approxBytes(value: unknown): number {
	if (value === undefined) return 0;
	return JSON.stringify(value)?.length ?? 0;
}

/**
 * Charge for one reserved op id.
 *
 * The reserved set is charged to the budget because with `OP_ID_RETENTION_MS` at
 * 24 hours it is the LARGEST structure in a busy room — one entry per op for a
 * whole day. Leaving it unaccounted lets a room sail past `memory.maxRoomBytes`
 * and OOM anyway, defeating the exact ceiling that exists to turn an OOM into a
 * typed error.
 *
 * The `+ 24` covers the Map entry and the number value; the budget is an
 * estimate within a constant factor, not an allocator.
 */
function reservationBytes(opId: string): number {
	return opId.length + 24;
}

// ── WAL records ───────────────────────────────────────────────────────────

/** The row half of a durable mutation, mirroring the `putRow` arguments. */
export interface WalRowMutation {
	table: string;
	rowId: string;
	/** `null` deletes the row, matching `StorageAdapter.putRow`. */
	row: Record<string, unknown> | null;
	colClocks: Record<string, string>;
	hlc: string;
}

/**
 * One line of a WAL segment.
 *
 * NOT bare `OpLogEntry` values, for two reasons that only show up on boot:
 *
 * 1. `putRow` is part of `StorageAdapter` and is called without a matching
 *    `appendOp` (the `ensureAtomicApplyOp` shim path, `SyncServer.applyServerOp`,
 *    and every test that writes rows directly). A WAL of ops alone silently
 *    loses those rows on restart.
 * 2. An `OpLogEntry.payload` is the *incoming* payload, not the *resolved* row.
 *    Reconstructing row state from it would mean re-running conflict resolution
 *    during replay — re-deriving a decision that was already made, against a
 *    policy that may have changed since. Recording the resolved row instead
 *    makes replay a straight assignment.
 *
 * `"apply"` fuses the two halves into a single record so an atomic `applyOp`
 * cannot be split across two segments by a buffer drain. That split is exactly
 * the row-store/op-log divergence `applyOp` exists to prevent.
 *
 * Because a row record carries absolute state and records are appended in the
 * order memory was mutated, replaying any suffix of the log on top of any
 * point-in-time snapshot converges on the same state. That invariant is what
 * makes compaction safe.
 */
export type WalRecord =
	| { k: "row"; row: WalRowMutation }
	| { k: "op"; op: OpLogEntry }
	| { k: "apply"; row: WalRowMutation; op: OpLogEntry }
	| { k: "reserve"; opIds: string[]; at: number };

/**
 * The HLC a record contributes to `WalSegmentRef.maxHlc`.
 *
 * A `reserve` record has none: it is replay-protection bookkeeping, not a
 * mutation, and letting it advance `oplogHead` would tell a resuming client that
 * data changed when nothing did. Callers must treat `""` as "contributes
 * nothing".
 */
export function recordHlc(record: WalRecord): string {
	if (record.k === "reserve") return "";
	return record.k === "op" ? record.op.hlc : record.row.hlc;
}

// ── room state ────────────────────────────────────────────────────────────

interface RowEntry {
	row: Record<string, unknown>;
	colClocks: Record<string, string>;
	hlc: string;
	/** Charged to the budget on insert, refunded on replace or delete. */
	bytes: number;
}

interface OpEntry {
	entry: OpLogEntry;
	bytes: number;
}

/**
 * Reserved op ids expire after this window. Matches
 * `OP_ID_RETENTION_MS` in `storage/sqlite.ts` — the replay-protection window is
 * a protocol property, not a storage-engine one, so the adapters must agree or
 * a client's resend behaves differently depending on which backend it hit.
 */
const OP_ID_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Sweeping expired op ids is O(reserved), so it is rate-limited rather than run
 * on every reserve. `sqlite.ts` samples randomly (1% of calls) because it has no
 * cheap clock; here `now()` is already injected, so a time gate does the same
 * job deterministically — a test driving the clock forward sees the sweep it
 * expects instead of one that fires 1% of the time.
 */
const OP_ID_SWEEP_INTERVAL_MS = 60_000;

export interface RoomStateOptions {
	memory: Required<MemoryConfig>;
	clock?: Clock;
	/** Defaults to the process-wide budget; tests pass their own for isolation. */
	budget?: ProcessMemoryBudget;
}

export class RoomState {
	private readonly memory: Required<MemoryConfig>;
	private readonly clock: Clock;
	private readonly budget: ProcessMemoryBudget;

	private readonly rows = new Map<string, Map<string, RowEntry>>();
	/**
	 * The op ring: recent ops in ascending HLC order. Bounded by
	 * `deleteOpsBefore` (the compaction manager's cutoff), not by a fixed
	 * capacity — the retention policy lives one layer up.
	 */
	private ops: OpEntry[] = [];
	private readonly reserved = new Map<string, number>();
	private readonly meta = new Map<string, string>();

	private roomBytes = 0;
	private highestHlc: string | null = null;
	private lastSweepAt = 0;

	constructor(options: RoomStateOptions) {
		this.memory = options.memory;
		this.clock = options.clock ?? systemClock;
		this.budget = options.budget ?? processMemoryBudget;
		this.budget.constrain(this.memory.maxTotalBytes);
	}

	/** Approximate bytes held by this room. */
	get bytes(): number {
		return this.roomBytes;
	}

	/** Highest HLC applied to this room, across rows and ops. */
	get maxHlc(): string | null {
		return this.highestHlc;
	}

	// ── reads ─────────────────────────────────────────────────────────────

	getRow(table: string, rowId: string): ExistingRow {
		const entry = this.rows.get(table)?.get(rowId);
		// A miss is `{ row: null, rowHlc: null, colClocks: {} }`, not a throw:
		// conflict resolution reads that shape as "no existing row" and accepts
		// the incoming write unconditionally.
		if (!entry) return { row: null, rowHlc: null, colClocks: {} };
		return { row: { ...entry.row }, rowHlc: entry.hlc, colClocks: { ...entry.colClocks } };
	}

	getRowsByIds(table: string, rowIds: string[]): Record<string, ExistingRow> {
		const out: Record<string, ExistingRow> = {};
		const tableRows = this.rows.get(table);
		if (!tableRows) return out;
		for (const rowId of rowIds) {
			const entry = tableRows.get(rowId);
			// Missing rows are absent from the result, per the `StorageAdapter`
			// contract — an explicit empty `ExistingRow` here would make the
			// handler treat a miss as a row it had already read.
			if (entry) {
				out[rowId] = {
					row: { ...entry.row },
					rowHlc: entry.hlc,
					colClocks: { ...entry.colClocks },
				};
			}
		}
		return out;
	}

	getRows(
		table: string,
		filter?: Record<string, unknown>,
	): {
		rows: Record<string, unknown>[];
		colClocks: Record<string, Record<string, string>>;
	} {
		const rows: Record<string, unknown>[] = [];
		const colClocks: Record<string, Record<string, string>> = {};
		const tableRows = this.rows.get(table);
		if (!tableRows) return { rows, colClocks };

		const filterKeys = filter ? Object.keys(filter) : [];
		for (const [rowId, entry] of tableRows) {
			if (filterKeys.length > 0) {
				let matches = true;
				for (const key of filterKeys) {
					if (entry.row[key] !== filter![key]) {
						matches = false;
						break;
					}
				}
				if (!matches) continue;
			}
			// Rows are copied out rather than shared. State here is authoritative,
			// so handing a caller the live object means a query callback that sorts
			// or mutates its result corrupts the database in place — a class of bug
			// the SQLite and Postgres adapters cannot have, because they deserialize
			// on every read. A shallow copy is still far cheaper than their
			// `JSON.parse`, so this stays the fastest adapter.
			rows.push({ ...entry.row });
			colClocks[rowId] = { ...entry.colClocks };
		}
		return { rows, colClocks };
	}

	getOpsSince(since: string, tables: string[]): OpLogEntry[] {
		if (tables.length === 0) return [];
		const wanted = new Set(tables);
		const out: OpLogEntry[] = [];
		// The ring is kept sorted, so the range is a suffix and the scan starts at
		// its first element rather than at op zero. A long-offline client asking
		// for a watermark near the head must not pay for the whole history.
		for (let i = this.indexAfter(since); i < this.ops.length; i++) {
			const op = this.ops[i]!;
			if (wanted.has(op.entry.table)) out.push({ ...op.entry });
		}
		return out;
	}

	getChangedTablesSince(since: string, tables: string[]): string[] {
		if (tables.length === 0) return [];
		const wanted = new Set(tables);
		const changed = new Set<string>();
		for (let i = this.indexAfter(since); i < this.ops.length; i++) {
			const table = this.ops[i]!.entry.table;
			if (wanted.has(table)) changed.add(table);
			// Every wanted table already changed — the rest of the scan cannot add
			// anything. Resume asks this on a watermark that may be hours old.
			if (changed.size === wanted.size) break;
		}
		return [...changed];
	}

	getOplogHead(tables: string[]): string | null {
		if (tables.length === 0) return null;
		const wanted = new Set(tables);
		// Backwards from the head: HA polling calls this on every tick purely to
		// ask "did anything change", so the common answer must be O(1).
		for (let i = this.ops.length - 1; i >= 0; i--) {
			const op = this.ops[i]!;
			if (wanted.has(op.entry.table)) return op.entry.hlc;
		}
		return null;
	}

	getMeta(key: string): string | null {
		return this.meta.get(key) ?? null;
	}

	/** Every meta pair, for a manifest commit. Small by contract. */
	metaSnapshot(): Record<string, string> {
		return Object.fromEntries(this.meta);
	}

	// ── writes ────────────────────────────────────────────────────────────

	/**
	 * @throws {MemoryLimitExceededError} before mutating anything, so a rejected
	 * write leaves no trace in authoritative state.
	 */
	putRow(
		table: string,
		rowId: string,
		row: Record<string, unknown> | null,
		colClocks: Record<string, string>,
		hlc: string,
	): void {
		let tableRows = this.rows.get(table);
		const previous = tableRows?.get(rowId);

		// `putRow(..., null, ...)` is a delete, not a write of a null row —
		// `StorageAdapter.putRow` defines it that way and the conformance suite
		// asserts it.
		if (row === null) {
			if (previous && tableRows) {
				this.addBytes(-previous.bytes);
				tableRows.delete(rowId);
				if (tableRows.size === 0) this.rows.delete(table);
			}
			this.noteHlc(hlc);
			return;
		}

		const bytes =
			table.length + rowId.length + hlc.length + approxBytes(row) + approxBytes(colClocks);
		// Charge the delta, not the new size: replacing a 1KB row with a 1KB row
		// must not look like 1KB of growth.
		this.addBytes(bytes - (previous?.bytes ?? 0));

		if (!tableRows) {
			tableRows = new Map();
			this.rows.set(table, tableRows);
		}
		// The incoming objects are copied in for the same reason reads copy out:
		// the caller still holds a reference to what it passed.
		tableRows.set(rowId, { row: { ...row }, colClocks: { ...colClocks }, hlc, bytes });
		this.noteHlc(hlc);
	}

	/**
	 * Charges the COMBINED cost of a row mutation plus its op up front, so an
	 * `applyOp` either admits both halves or mutates nothing.
	 *
	 * Without this, `applyOp` charges the row, mutates it, then charges the op —
	 * and a `MemoryLimitExceededError` on that second charge leaves the caller
	 * told the write was rejected while authoritative state already holds the
	 * row. That is exactly the row-store/op-log divergence `applyOp` exists to
	 * prevent, produced with no crash at all, and `toSnapshot` reads `this.rows`,
	 * so the next compaction would make the rejected row permanently durable with
	 * no op ever existing for it.
	 *
	 * Computes the true net delta rather than a conservative upper bound: a row
	 * replaced by one of the same size is not growth, and refusing it at the
	 * boundary would break a workload that never actually grows.
	 *
	 * @throws {MemoryLimitExceededError} leaving all state untouched.
	 */
	assertCanAdmitApply(mutation: WalRowMutation, op: OpLogEntry | null): void {
		const previous = this.rows.get(mutation.table)?.get(mutation.rowId);
		const rowBytes =
			mutation.row === null
				? 0
				: mutation.table.length +
					mutation.rowId.length +
					mutation.hlc.length +
					approxBytes(mutation.row) +
					approxBytes(mutation.colClocks);
		const delta = rowBytes - (previous?.bytes ?? 0) + (op ? approxBytes(op) : 0);
		// Only growth can be refused, and `addBytes` already ignores the limits for
		// a negative delta — so a check-only pass of the same guard suffices.
		if (delta > 0) this.checkBytes(delta);
	}

	appendOp(entry: OpLogEntry): void {
		const bytes = approxBytes(entry);
		this.addBytes(bytes);
		const item: OpEntry = { entry, bytes };
		const last = this.ops[this.ops.length - 1];
		// Ops normally arrive in HLC order, so the common case is a push. Out of
		// order still has to land in the right slot: `getOpsSince` binary-searches
		// the ring and the conformance suite appends h3 before h1.
		if (!last || last.entry.hlc <= entry.hlc) {
			this.ops.push(item);
		} else {
			this.ops.splice(this.indexAfter(entry.hlc), 0, item);
		}
		this.noteHlc(entry.hlc);
	}

	deleteOpsBefore(hlc: string): number {
		const cut = this.indexBefore(hlc);
		if (cut === 0) return 0;
		const removed = this.ops.slice(0, cut);
		let freed = 0;
		for (const op of removed) freed += op.bytes;
		this.ops = this.ops.slice(cut);
		this.addBytes(-freed);
		return removed.length;
	}

	/**
	 * Reserve-or-detect-replay. Atomic by construction: there is exactly one
	 * writer per room and this runs to completion without an `await`, so the
	 * check-then-write race that forces the SQL adapters into
	 * `INSERT ... ON CONFLICT` cannot occur.
	 */
	reserveOp(opId: string): boolean {
		this.sweepReservedOps();
		if (this.reserved.has(opId)) return false;
		this.reserved.set(opId, this.clock.now());
		this.addBytes(reservationBytes(opId));
		return true;
	}

	reserveOps(opIds: string[]): string[] {
		if (opIds.length === 0) return [];
		this.sweepReservedOps();
		const now = this.clock.now();
		const fresh: string[] = [];
		for (const opId of opIds) {
			if (this.reserved.has(opId)) continue;
			this.reserved.set(opId, now);
			this.addBytes(reservationBytes(opId));
			fresh.push(opId);
		}
		return fresh;
	}

	setMeta(key: string, value: string): void {
		this.meta.set(key, value);
	}

	/** Seeds meta from the manifest at boot. Meta is durable in the manifest. */
	loadMeta(meta: Record<string, string>): void {
		this.meta.clear();
		for (const [key, value] of Object.entries(meta)) this.meta.set(key, value);
	}

	// ── boot and compaction ───────────────────────────────────────────────

	/** Replays one durable record. Used by boot; identical to the live path. */
	applyRecord(record: WalRecord): void {
		if (record.k === "reserve") {
			// Replayed with its ORIGINAL timestamp, not `now()`: the reservation
			// window is 24h from when the op was first seen, and re-stamping it on
			// every boot would keep a long-dead id alive indefinitely in a room that
			// restarts often.
			this.restoreReservations(record.opIds, record.at);
			return;
		}
		if (record.k === "row" || record.k === "apply") {
			const { table, rowId, row, colClocks, hlc } = record.row;
			this.putRow(table, rowId, row, colClocks, hlc);
		}
		if (record.k === "op" || record.k === "apply") {
			this.appendOp(record.op);
		}
	}

	/**
	 * Re-admits reservations from a WAL record or a snapshot, keeping the earliest
	 * timestamp seen for an id so replay cannot extend its window.
	 */
	restoreReservations(opIds: Iterable<string>, at: number): void {
		const cutoff = this.clock.now() - OP_ID_RETENTION_MS;
		if (at < cutoff) return;
		for (const opId of opIds) {
			const existing = this.reserved.get(opId);
			if (existing === undefined) {
				this.reserved.set(opId, at);
				this.addBytes(reservationBytes(opId));
			} else if (at < existing) {
				// Already charged; only the timestamp moves earlier.
				this.reserved.set(opId, at);
			}
		}
	}

	applyRecords(records: WalRecord[]): void {
		for (const record of records) this.applyRecord(record);
	}

	toSnapshot(): SnapshotRecord {
		const rows: SnapshotRow[] = [];
		for (const [table, tableRows] of this.rows) {
			for (const [rowId, entry] of tableRows) {
				rows.push({ table, rowId, row: entry.row, colClocks: entry.colClocks, hlc: entry.hlc });
			}
		}
		// Expired reservations are dropped rather than written out: they would be
		// swept on the next reserve anyway, and a snapshot is the one place where
		// carrying dead weight costs a store round trip.
		const cutoff = this.clock.now() - OP_ID_RETENTION_MS;
		const reservedOps: [string, number][] = [];
		for (const [opId, at] of this.reserved) {
			if (at >= cutoff) reservedOps.push([opId, at]);
		}
		// NOTE: `SnapshotRecord` carries rows and reservations but no ops, so
		// compaction is also the op log's retention boundary — a process that
		// restarts after compacting cannot serve `getOpsSince` for the compacted
		// range. That matches `deleteOpsBefore` semantics on the SQL adapters
		// (compacted means permanently lost, per CompactionManager), and resume
		// degrades to a full snapshot rather than breaking. The in-memory ring is
		// NOT trimmed by compaction, so a live process keeps serving its full
		// retained history.
		return { version: 1, hlc: this.highestHlc, rows, reservedOps };
	}

	loadSnapshot(record: SnapshotRecord): void {
		this.reset();
		for (const row of record.rows) {
			this.putRow(row.table, row.rowId, row.row, row.colClocks, row.hlc);
		}
		const cutoff = this.clock.now() - OP_ID_RETENTION_MS;
		for (const [opId, at] of record.reservedOps) {
			if (at < cutoff) continue;
			this.reserved.set(opId, at);
			this.addBytes(reservationBytes(opId));
		}
		if (record.hlc && (!this.highestHlc || record.hlc > this.highestHlc)) {
			this.highestHlc = record.hlc;
		}
	}

	/** Returns this room's bytes to the process budget. */
	dispose(): void {
		this.reset();
	}

	// ── internals ─────────────────────────────────────────────────────────

	private reset(): void {
		this.addBytes(-this.roomBytes);
		this.rows.clear();
		this.ops = [];
		this.reserved.clear();
		this.highestHlc = null;
	}

	private noteHlc(hlc: string): void {
		if (!this.highestHlc || hlc > this.highestHlc) this.highestHlc = hlc;
	}

	/**
	 * Charges `delta` against the room and process budgets.
	 *
	 * Checked before the mutation, never after: state is authoritative in memory,
	 * so a partially applied write that then throws would leave the room holding
	 * data the caller believes was rejected.
	 */
	/** The admission guard, with no side effects. `addBytes` and `assertCanAdmitApply` share it. */
	private checkBytes(delta: number): void {
		const roomTotal = this.roomBytes + delta;
		if (roomTotal > this.memory.maxRoomBytes) {
			this.refuse(roomTotal, this.memory.maxRoomBytes);
		}
		const processTotal = this.budget.used + delta;
		if (processTotal > this.budget.limit) {
			this.refuse(processTotal, this.budget.limit);
		}
	}

	private addBytes(delta: number): void {
		if (delta > 0) this.checkBytes(delta);
		this.roomBytes += delta;
		if (this.roomBytes < 0) this.roomBytes = 0;
		this.budget.add(delta);
	}

	private refuse(used: number, limit: number): never {
		const policy: MemoryPolicy = this.memory.onExceeded;
		if (policy !== "reject") {
			// Accepted as configuration, refused at the boundary. Failing at
			// construction instead would reject a config that may never reach its
			// limit; failing here names the policy at the moment it would have
			// mattered, which is the only moment the operator can act on it.
			throw new Error(
				`memory.onExceeded: "${policy}" is not implemented in phase 1 ` +
					`(state exceeded ${limit} bytes). "evict" lands in phase 2 and "spill" ` +
					`— DuckDB-over-Parquet reads — in phase 3, because it needs the Parquet ` +
					`layer. Use "reject" and raise memory.maxRoomBytes / maxTotalBytes, or ` +
					`shard the room. See docs/object-storage.md.`,
			);
		}
		throw new MemoryLimitExceededError(used, limit);
	}

	/** First index whose HLC is strictly greater than `hlc`. */
	private indexAfter(hlc: string): number {
		let lo = 0;
		let hi = this.ops.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.ops[mid]!.entry.hlc > hlc) hi = mid;
			else lo = mid + 1;
		}
		return lo;
	}

	/** First index whose HLC is greater than or equal to `hlc`. */
	private indexBefore(hlc: string): number {
		let lo = 0;
		let hi = this.ops.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.ops[mid]!.entry.hlc >= hlc) hi = mid;
			else lo = mid + 1;
		}
		return lo;
	}

	private sweepReservedOps(): void {
		const now = this.clock.now();
		if (now - this.lastSweepAt < OP_ID_SWEEP_INTERVAL_MS) return;
		this.lastSweepAt = now;
		const cutoff = now - OP_ID_RETENTION_MS;
		let freed = 0;
		for (const [opId, at] of this.reserved) {
			if (at < cutoff) {
				this.reserved.delete(opId);
				freed += reservationBytes(opId);
			}
		}
		// Refund in one call rather than per id: `addBytes` clamps and touches the
		// shared process budget, and a sweep can drop many thousands of entries.
		if (freed > 0) this.addBytes(-freed);
	}
}
