/**
 * `StorageAdapter` backed by object storage alone — no Postgres, no SQLite.
 *
 * Design and rationale: docs/object-storage.md. The shape of it:
 *
 *   - State is authoritative in memory (`state.ts`). Every read is answered
 *     there, so reads never touch the network.
 *   - Writes mutate memory and append to a buffer that group-commits one
 *     object per batch (`wal.ts`).
 *   - A CAS'd manifest is the single linearization point and the only thing
 *     standing between two writers and corruption (`manifest.ts`).
 *   - Boot is one GET of the manifest plus the objects it names.
 *
 * `applyOp` is implemented here as a memory mutation plus one buffer append
 * with no `await` between them, which is atomic by construction — so
 * `ensureAtomicApplyOp` returns this adapter untouched and never installs its
 * non-atomic shim.
 *
 * No module in this directory may statically import a `node:` builtin: `bunup`
 * builds `src/` with `target: "browser"` and hoists such an import into a
 * shared chunk that every entry point side-effect-imports, which breaks
 * consumer bundles outright.
 */

import type { ExistingRow } from "../../conflict.ts";
import type { OpLogEntry, StorageAdapter } from "../../handler.ts";
import { IncompleteStateError, OBJECT_STORAGE_DEFAULTS } from "./types.ts";
import type {
	BatchConfig,
	CompactionConfig,
	LeaseConfig,
	MemoryConfig,
	ObjectDriver,
	ObjectStorageConfig,
	ResolvedObjectStorageConfig,
	SnapshotRecord,
	StorageHealth,
} from "./types.ts";
import { ProcessMemoryBudget, RoomState, systemClock } from "./state.ts";
import type { Clock, WalRecord, WalRowMutation } from "./state.ts";
import { ManifestStore, decodeJson, encodeJson, roomPrefix } from "./manifest.ts";
import { WalWriter, decodeSegment } from "./wal.ts";
import { createS3Driver } from "./drivers/s3.ts";

export { createMemoryDriver } from "./drivers/memory.ts";
export { createFilesystemDriver } from "./drivers/filesystem.ts";
export { createS3Driver } from "./drivers/s3.ts";
// Addressing a room's keys from outside — an admin wipe, a disposable demo
// clearing an unbootable room — needs the same prefix the adapter writes under.
export { roomPrefix } from "./manifest.ts";

export {
	BackpressureError,
	IncompleteStateError,
	MemoryLimitExceededError,
	NotWriterError,
	PreconditionFailedError,
	OBJECT_STORAGE_DEFAULTS,
} from "./types.ts";
export type {
	BackpressurePolicy,
	BatchConfig,
	CompactionConfig,
	DurabilityMode,
	LeaseConfig,
	LeaseMode,
	LeaseRecord,
	ManifestRecord,
	MemoryConfig,
	MemoryPolicy,
	ObjectDriver,
	ObjectDriverCapabilities,
	ObjectListEntry,
	ObjectPutOptions,
	ObjectRecord,
	ObjectStorageConfig,
	ResolvedObjectStorageConfig,
	SnapshotRecord,
	SnapshotRow,
	StorageHealth,
	StoreConfig,
	StoreCredentials,
	StoreProvider,
	WalSegmentRef,
} from "./types.ts";

/** The adapter plus the lifecycle and observability surface the design adds. */
export interface ObjectStorage extends StorageAdapter {
	/**
	 * Boots the room: manifest, snapshot, WAL replay. Idempotent, and implied by
	 * the first call to any other method — call it explicitly to surface boot
	 * failures at startup rather than on the first query.
	 */
	init(): Promise<void>;
	/** Drains the write buffer and resolves once everything buffered is durable. */
	flush(): Promise<void>;
	close(): Promise<void>;
	readonly health: StorageHealth;
	/** Highest HLC known durable. Phase 2 broadcasts this as the retire watermark. */
	readonly durableHlc: string | null;
	onDurable(callback: (hlc: string) => void): void;
	onHealthChange(callback: (health: StorageHealth) => void): void;
	/**
	 * Folds in anything another instance has committed since this one last
	 * looked, and reports whether the room actually moved.
	 *
	 * Only meaningful under `concurrency: "optimistic"`, where in-memory state is
	 * NOT authoritative — under `"single-writer"` this instance IS the writer, so
	 * there is nothing to catch up on and this resolves `false` without a request.
	 *
	 * Costs one GET, and does nothing further when the manifest's `commitSeq` has
	 * not moved. That is what makes a serverless poll loop affordable: the steady
	 * state is a single small conditional read, and queries re-run only when this
	 * returns true.
	 */
	refresh(): Promise<boolean>;
}

export interface ObjectStorageOptions {
	/** Injected for deterministic tests; defaults to wall-clock time and timers. */
	clock?: Clock;
	/** Process-wide memory budget. Tests pass their own so suites do not share one. */
	budget?: ProcessMemoryBudget;
}

/**
 * Copies `overrides` over `defaults`, ignoring keys explicitly set to
 * `undefined`. A plain spread would let `{ maxBytes: undefined }` — which is
 * what an optional property forwarded from a caller's own config looks like —
 * erase the default and leave `NaN` arithmetic downstream.
 */
function applyOverrides<T extends object>(target: T, overrides: Partial<T> | undefined): void {
	if (!overrides) return;
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) (target as Record<string, unknown>)[key] = value;
	}
}

export function resolveObjectStorageConfig(
	config: ObjectStorageConfig,
): ResolvedObjectStorageConfig {
	const batch: Required<BatchConfig> = { ...OBJECT_STORAGE_DEFAULTS.batch };
	applyOverrides(batch, config.batch);
	const compaction: Required<CompactionConfig> = { ...OBJECT_STORAGE_DEFAULTS.compaction };
	applyOverrides(compaction, config.compaction);
	const lease: Required<LeaseConfig> = { ...OBJECT_STORAGE_DEFAULTS.lease };
	applyOverrides(lease, config.lease);
	const memory: Required<MemoryConfig> = { ...OBJECT_STORAGE_DEFAULTS.memory };
	applyOverrides(memory, config.memory);

	return {
		roomId: config.roomId,
		// A random writer id is fine — the epoch, not the name, is the fencing
		// token. Setting it explicitly only makes lease ownership legible in logs.
		writerId: config.writerId ?? `writer-${crypto.randomUUID()}`,
		durability: config.durability ?? OBJECT_STORAGE_DEFAULTS.durability,
		concurrency: config.concurrency ?? OBJECT_STORAGE_DEFAULTS.concurrency,
		retentionMs: config.retentionMs ?? OBJECT_STORAGE_DEFAULTS.retentionMs,
		batch,
		compaction,
		lease,
		memory,
		shutdownFlushMs: config.shutdownFlushMs ?? OBJECT_STORAGE_DEFAULTS.shutdownFlushMs,
	};
}

function resolveDriver(config: ObjectStorageConfig): ObjectDriver {
	if (config.driver && config.store) {
		throw new Error(
			"createObjectStorage: pass either `driver` or `store`, not both. `store` builds " +
				"the S3 driver for you; `driver` is for a pre-built or custom one.",
		);
	}
	if (config.driver) return config.driver;
	if (config.store) return createS3Driver(config.store);
	throw new Error(
		"createObjectStorage: one of `driver` or `store` is required — there is no " +
			"default object store to fall back to.",
	);
}

export function createObjectStorage(
	config: ObjectStorageConfig,
	options: ObjectStorageOptions = {},
): ObjectStorage {
	const resolved = resolveObjectStorageConfig(config);
	const driver = resolveDriver(config);
	const clock = options.clock ?? systemClock;
	const prefix = roomPrefix(resolved.roomId);

	const state = new RoomState({ memory: resolved.memory, clock, budget: options.budget });
	const manifest = new ManifestStore({
		driver,
		roomId: resolved.roomId,
		writerId: resolved.writerId,
		lease: resolved.lease,
		concurrency: resolved.concurrency,
		clock,
	});
	const wal = new WalWriter({
		driver,
		manifest,
		roomId: resolved.roomId,
		batch: resolved.batch,
		durability: resolved.durability,
		concurrency: resolved.concurrency,
		writerId: resolved.writerId,
		clock,
		onCommitted: () => maintain(),
	});

	if (config.onDurable) wal.onDurable(config.onDurable);
	if (config.onHealthChange) wal.onHealthChange(config.onHealthChange);

	let snapshotSeq = 0;
	/**
	 * Segment keys already folded into local state, so `refresh()` applies only
	 * what it has not seen. Tracked by key rather than by count because in
	 * `"optimistic"` mode segments from several instances interleave in
	 * `walSegs`, so an index into that array means nothing locally.
	 */
	let appliedSegments = new Set<string>();
	/** Snapshot currently loaded into state, so `refresh()` can spot another instance's compaction. */
	let appliedSnapshotKey: string | null = null;
	let closed = false;
	let closing: Promise<void> | null = null;
	let bootPromise: Promise<void> | null = null;

	// ── boot ──────────────────────────────────────────────────────────────

	/**
	 * Whether this instance wrote the segment, and therefore already has its
	 * records in memory — writes mutate state before they are ever flushed.
	 *
	 * Only a `refresh()` optimization: re-applying one would be correct anyway,
	 * since row records carry absolute state, just a wasted GET on every poll for
	 * every segment this instance has written.
	 */
	function isOwnSegment(key: string): boolean {
		return (
			resolved.concurrency === "optimistic" &&
			key.startsWith(`${prefix}wal/${resolved.writerId}-`)
		);
	}

	/** Fetches one WAL segment and applies it to memory. Shared by boot and refresh. */
	async function applySegment(key: string): Promise<void> {
		const object = await driver.get(key);
		if (!object) {
			// A hard error, never a skip: the manifest names this object, so its
			// absence means the store lost data the room was told was durable.
			throw new Error(
				`Object storage: WAL segment "${key}" named by the manifest for room ` +
					`"${resolved.roomId}" is missing. Refusing to serve a truncated log.`,
			);
		}
		state.applyRecords(decodeSegment(object.body, key));
	}

	async function boot(): Promise<void> {
		// No-op unless the driver lacks create-if-absent (MinIO). See
		// `ManifestStore.init` — on such a driver this is the seeding deploy step,
		// safe only because this design routes exactly one writer per room.
		await manifest.init();
		const record = await manifest.load();
		state.loadMeta(record.meta);

		if (record.snapshotKey) {
			const object = await driver.get(record.snapshotKey);
			if (!object) {
				// A hard error, never a skip. The manifest names this object, so its
				// absence means the store lost data the room was told was durable —
				// booting on an empty state would present that loss as an empty room
				// and then overwrite the remaining segments with new writes.
				throw new IncompleteStateError(
					resolved.roomId,
					record.snapshotKey,
					"Refusing to boot with incomplete state.",
				);
			}
			state.loadSnapshot(decodeJson<SnapshotRecord>(object.body, record.snapshotKey));
			appliedSnapshotKey = record.snapshotKey;
		}

		// Every listed segment is replayed, in commit order. The design doc
		// mentions skipping segments at or below `snapshotHlc`; that check is
		// unnecessary here and would be actively unsafe. Compaction empties
		// `walSegs` in the same CAS that publishes the snapshot, so membership in
		// `walSegs` already means "committed after the snapshot" — while HLC is
		// assigned by the caller and is not append order, so a `putRow` carrying a
		// low HLC after a compaction would be silently dropped by an HLC test.
		for (const segment of record.walSegs) await applySegment(segment.key);
		appliedSegments = new Set(record.walSegs.map((segment) => segment.key));

		// Under `lease.mode: "always"` the lease is taken now and renewed on a
		// timer. Under `"on-write"` (the default) this is a no-op and nothing is
		// written until the first write, so an idle room issues zero PUTs.
		await manifest.start();
	}

	function ready(): Promise<void> {
		// Boot is lazy rather than fired from the factory: an unawaited promise
		// rejecting at construction is an unhandled rejection with no caller to
		// report it to. The first method call — or an explicit `init()` — owns it.
		if (!bootPromise) {
			// A FAILED boot must not be cached. Boot issues one GET per manifest,
			// snapshot and WAL segment — up to `compaction.afterSegments` of them
			// just before a compaction — with no retry anywhere, so it is the
			// highest-fan-out, least-protected path in the adapter. Caching the
			// rejection would let a single transient 503 on any one of those GETs
			// brick the room permanently: every later call would re-throw the same
			// stale error, with no way back short of constructing a new adapter.
			//
			// Clearing it on failure makes the next call retry the boot. Success is
			// still cached, so the happy path boots exactly once.
			bootPromise = boot().catch((error: unknown) => {
				bootPromise = null;
				throw error;
			});
		}
		return bootPromise;
	}

	function assertOpen(): void {
		if (closed) {
			throw new Error(
				`Object storage: room "${resolved.roomId}" is closed and no longer accepts writes.`,
			);
		}
	}

	// ── the write path ────────────────────────────────────────────────────

	/**
	 * Admit, mutate, append. The order is load-bearing: `prepare` is the only
	 * step that can reject the write, and it runs BEFORE the memory mutation so a
	 * rejected write leaves nothing behind in authoritative state. There is no
	 * `await` between the mutation and the append, which is what makes the pair
	 * atomic without a transaction.
	 */
	function submit(record: WalRecord, mutate: () => void): Promise<void> {
		const prepared = wal.prepare(record);
		mutate();
		return wal.append(prepared);
	}

	/**
	 * Makes a reservation durable by riding the next batch.
	 *
	 * Deliberately not awaited. `reserveOp` runs BEFORE the op it guards, and the
	 * op's own `applyOp` awaits the very batch this record lands in — so under
	 * `durability: "durable"` the reservation is durable by the time the write it
	 * protects is acknowledged, at zero extra round trips.
	 *
	 * It has to be durable at all because `reserveOp` gates the whole pipeline in
	 * `op-processor.ts`, including a query's `mutate` callback. That callback is
	 * arbitrary user code — incrementing a counter, charging something, sending a
	 * mail — so "a duplicate is harmless because LWW discards it" only covers the
	 * row write, not the side effect. Losing the reservation window on every
	 * restart would re-run those callbacks for any client that reconnects and
	 * resends, which on a platform that replaces machines constantly is not a rare
	 * case.
	 *
	 * Backpressure rejection is swallowed rather than propagated: refusing to
	 * RECORD a reservation must not refuse the reservation itself, which has
	 * already been granted in memory and cannot be taken back. The window
	 * degrades to its previous non-durable behavior for that op, and the write it
	 * guards will hit the same backpressure and surface it properly.
	 */
	function persistReservations(opIds: string[]): void {
		try {
			void wal.append(wal.prepare({ k: "reserve", opIds, at: clock.now() })).catch(() => undefined);
		} catch {
			// Buffer full or writer stopped; see above.
		}
	}

	// ── compaction and GC ─────────────────────────────────────────────────

	/**
	 * Runs after every committed batch. Activity-gated by construction: it is
	 * only ever reached from a flush, so an idle room never compacts and never
	 * pays for a timer.
	 */
	async function maintain(): Promise<void> {
		await compactIfDue();
		await collectGarbage();
	}

	async function compactIfDue(): Promise<void> {
		const current = manifest.manifest;
		let bytes = 0;
		for (const segment of current.walSegs) bytes += segment.bytes;
		// Gated on segment count and bytes rather than a clock. Self-clocking
		// flushes produce many small segments under sustained load — an hour of
		// active drawing is ~18,000 of them — and boot cost is one GET per
		// segment, so without this, boot time degrades linearly with write volume.
		if (
			current.walSegs.length < resolved.compaction.afterSegments &&
			bytes < resolved.compaction.afterBytes
		) {
			return;
		}

		const snapshot = state.toSnapshot();
		// Named by writer and sequence, not by HLC: an HLC embeds the node id, which
		// routinely contains characters (`:`) that are illegal in a filename on
		// Windows and awkward in a URL. The manifest records the key, so the name
		// carries no meaning of its own.
		//
		// The token is the writer id under `"optimistic"`, exactly as WAL segment
		// names are (`WalWriter.flushOnce`), and for the same reason: there is no
		// lease there, so every instance reads the same manifest epoch and two
		// cold invocations both name their first snapshot `snap/0-0.json`. The
		// second commit then pushes that key into `pendingGc` while setting it as
		// the live `snapshotKey`, and an hour later GC deletes the object the
		// manifest points at — the room is bricked, permanently, with
		// `IncompleteStateError` on every boot. That is not hypothetical: it is
		// what took out the kanban demo's `demo` board.
		const token = resolved.concurrency === "optimistic" ? resolved.writerId : String(manifest.epoch);
		const key = `${prefix}snap/${token}-${snapshotSeq++}.json`;
		await driver.put(key, encodeJson(snapshot));

		const deletableAt = clock.now() + resolved.compaction.gcGraceMs;
		const committed = await manifest.commit((next) => {
			for (const segment of next.walSegs) next.pendingGc.push({ key: segment.key, deletableAt });
			if (next.snapshotKey) next.pendingGc.push({ key: next.snapshotKey, deletableAt });
			next.walSegs = [];
			next.snapshotKey = key;
			next.snapshotHlc = snapshot.hlc;

			// Advancing the compaction cutoff is NOT bookkeeping — it is the only
			// thing standing between this and silent stale data.
			//
			// A `SnapshotRecord` carries rows and reservations but no ops, and this
			// CAS clears `walSegs`, so after the next restart the op ring boots
			// EMPTY. `handleResume` in handler.ts rejects a client whose watermark
			// predates `getMeta("compactionCutoff")`; with no cutoff recorded it
			// instead asks `getChangedTablesSince`, gets `[]` from that empty ring,
			// and tells the client nothing changed. The client then keeps rows that
			// are arbitrarily out of date, forever, with no error anywhere.
			//
			// `CompactionManager` states the contract for the SQL adapters — "commit
			// cutoff first, then lazily delete ops" — and this is the same contract:
			// whatever makes ops unavailable owns advancing the cutoff. Doing it in
			// this CAS rather than through `setMeta` makes it atomic with the
			// truncation it describes, so there is no window where the ops are gone
			// but the cutoff still says otherwise.
			//
			// Monotonic, because `handleResume` compares against it directly and a
			// cutoff that moved backwards would start admitting resumes it had
			// already correctly rejected.
			const cutoff = snapshot.hlc;
			if (cutoff && (!next.meta.compactionCutoff || cutoff > next.meta.compactionCutoff)) {
				next.meta.compactionCutoff = cutoff;
			}
		});

		// The in-memory copy `getMeta` serves is updated only AFTER the CAS lands.
		// `mutate` runs before the PUT, so setting it there would publish a cutoff
		// that is not durable if the commit then failed. The direction is benign —
		// a too-high cutoff rejects resumes rather than admitting bad ones — but
		// reading it off the committed manifest costs nothing and removes the
		// caveat entirely. `handleResume` reads this through `getMeta`, not off the
		// manifest, so the two must not drift.
		const committedCutoff = committed.meta.compactionCutoff;
		if (committedCutoff) state.setMeta("compactionCutoff", committedCutoff);
		// The commit emptied `walSegs`, so every tracked key is now stale. Keeping
		// them would leak one string per segment for the life of the process.
		appliedSegments = new Set();
		// This instance's state already reflects the snapshot it just wrote. Without
		// recording that, its own next `refresh()` would see a snapshotKey it does
		// not recognise and rebuild from the object it had just serialized.
		appliedSnapshotKey = key;
	}

	/**
	 * Deletes superseded objects, but only once the grace period has elapsed.
	 *
	 * The delay is the whole point. A reader that fetched the previous manifest
	 * may be part-way through GETting a segment this manifest no longer lists;
	 * deleting it the moment the CAS lands turns that reader's in-flight read
	 * into a 404 and a failed boot. The objects are immutable and cheap, so
	 * waiting `gcGraceMs` (1 hour) costs almost nothing and removes the race
	 * entirely.
	 */
	async function collectGarbage(): Promise<void> {
		const now = clock.now();
		const due = manifest.manifest.pendingGc.filter((entry) => entry.deletableAt <= now);
		if (due.length === 0) return;

		// Never delete a key the manifest currently names, however it got onto the
		// list. `pendingGc` records what a commit SUPERSEDED, so a key that is live
		// again means two writers picked the same name — the failure mode that
		// bricked a room before snapshot keys carried the writer id. Belt to that
		// braces: the entry is still dropped from `pendingGc` below, and if the key
		// is superseded later, that commit puts it back.
		const live = new Set<string>();
		if (manifest.manifest.snapshotKey) live.add(manifest.manifest.snapshotKey);
		for (const segment of manifest.manifest.walSegs) live.add(segment.key);
		const deletable = due.filter((entry) => !live.has(entry.key));

		// Delete first, then forget: an absent key is not an error on delete, so a
		// crash between the two costs one wasted retry. The reverse order would
		// leak objects nothing references and nothing will ever revisit.
		if (deletable.length > 0) await driver.delete(deletable.map((entry) => entry.key));
		await manifest.commit((next) => {
			next.pendingGc = next.pendingGc.filter((entry) => entry.deletableAt > now);
		});
	}

	// ── adapter ───────────────────────────────────────────────────────────

	const adapter: ObjectStorage = {
		async init(): Promise<void> {
			await ready();
		},

		async getRow(table: string, rowId: string): Promise<ExistingRow> {
			await ready();
			return state.getRow(table, rowId);
		},

		async getRowsByIds(table: string, rowIds: string[]): Promise<Record<string, ExistingRow>> {
			await ready();
			if (rowIds.length === 0) return {};
			return state.getRowsByIds(table, rowIds);
		},

		async putRow(
			table: string,
			rowId: string,
			row: Record<string, unknown> | null,
			colClocks: Record<string, string>,
			hlc: string,
		): Promise<void> {
			await ready();
			assertOpen();
			const mutation: WalRowMutation = { table, rowId, row, colClocks, hlc };
			await submit({ k: "row", row: mutation }, () =>
				state.putRow(table, rowId, row, colClocks, hlc),
			);
		},

		async getRows(
			table: string,
			filter?: Record<string, unknown>,
		): Promise<{
			rows: Record<string, unknown>[];
			colClocks: Record<string, Record<string, string>>;
		}> {
			await ready();
			return state.getRows(table, filter);
		},

		async appendOp(entry: OpLogEntry): Promise<void> {
			await ready();
			assertOpen();
			await submit({ k: "op", op: entry }, () => state.appendOp(entry));
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
			await ready();
			assertOpen();
			const mutation: WalRowMutation = { table, rowId, row, colClocks, hlc };
			const op: OpLogEntry = { table, op: opType, rowId, payload, hlc, colClocks };
			// Charge both halves before either lands. `state.putRow` followed by
			// `state.appendOp` charges the budget twice, and a refusal on the SECOND
			// charge would leave the row in authoritative state while the caller is
			// told the write failed — the divergence this method exists to prevent,
			// reached with no crash at all. `submit` guarantees no `await` splits the
			// two mutations, but only this makes the pair all-or-nothing.
			state.assertCanAdmitApply(mutation, op);
			// One fused record, so a buffer drain can never split the row write from
			// its op — that split is exactly the row-store/op-log divergence this
			// method exists to prevent.
			await submit({ k: "apply", row: mutation, op }, () => {
				state.putRow(table, rowId, row, colClocks, hlc);
				state.appendOp(op);
			});
		},

		async getOpsSince(since: string, tables: string[]): Promise<OpLogEntry[]> {
			await ready();
			return state.getOpsSince(since, tables);
		},

		async getChangedTablesSince(since: string, tables: string[]): Promise<string[]> {
			await ready();
			return state.getChangedTablesSince(since, tables);
		},

		async getOplogHead(tables: string[]): Promise<string | null> {
			await ready();
			return state.getOplogHead(tables);
		},

		async deleteOpsBefore(hlc: string): Promise<number> {
			await ready();
			// In-memory only, and deliberately not written to the WAL. The op ring
			// is a cache of the durable log, not the log itself; a restart rebuilds
			// it from the segments the manifest still lists, and compaction — which
			// drops those segments — is the durable retention boundary.
			return state.deleteOpsBefore(hlc);
		},

		async reserveOp(opId: string): Promise<boolean> {
			await ready();
			// Atomic without any store round trip: there is exactly one writer per
			// room, and this runs to completion synchronously, so the check-then-write
			// race that forces the SQL adapters into `INSERT ... ON CONFLICT` cannot
			// occur here.
			const fresh = state.reserveOp(opId);
			if (fresh) persistReservations([opId]);
			return fresh;
		},

		async reserveOps(opIds: string[]): Promise<string[]> {
			await ready();
			const fresh = state.reserveOps(opIds);
			if (fresh.length > 0) persistReservations(fresh);
			return fresh;
		},

		async getMeta(key: string): Promise<string | null> {
			await ready();
			return state.getMeta(key);
		},

		/**
		 * Catches this instance up with the rest of the fleet.
		 *
		 * Applies only the segments the local state has not already seen, tracked
		 * by key: a segment this instance wrote is already in memory, and replaying
		 * it would be wasted work (harmless, since row records carry absolute
		 * state, but wasted). When the snapshot pointer moved — another instance
		 * compacted — the local view is rebuilt from that snapshot instead, because
		 * the segments it superseded may already be gone.
		 */
		async refresh(): Promise<boolean> {
			// Under `"single-writer"` this instance holds the only lease, so its
			// memory is by definition current and a GET would tell it nothing.
			if (resolved.concurrency !== "optimistic") return false;
			await ready();

			const next = await manifest.refresh();

			// Reconciled against what this instance has APPLIED, never against
			// `commitSeq`. The optimistic commit path reloads the manifest whenever
			// it loses a CAS, so the cached `commitSeq` can already be current while
			// the segments that came with it were never applied to state — a
			// commitSeq comparison would then report "nothing changed" and leave
			// this instance permanently blind to a rival's writes.
			if (next.snapshotKey && next.snapshotKey !== appliedSnapshotKey) {
				// Someone compacted. Rebuild rather than replay: the segments this
				// instance had not yet applied may have been folded into that snapshot
				// and moved to pendingGc.
				const object = await driver.get(next.snapshotKey);
				if (!object) {
					throw new IncompleteStateError(
						resolved.roomId,
						next.snapshotKey,
						"Refusing to serve incomplete state.",
					);
				}
				state.loadSnapshot(decodeJson<SnapshotRecord>(object.body, next.snapshotKey));
				state.loadMeta(next.meta);
				appliedSnapshotKey = next.snapshotKey;
				appliedSegments = new Set();
				for (const segment of next.walSegs) {
					await applySegment(segment.key);
					appliedSegments.add(segment.key);
				}
				return true;
			}

			let applied = false;
			for (const segment of next.walSegs) {
				if (appliedSegments.has(segment.key) || isOwnSegment(segment.key)) continue;
				await applySegment(segment.key);
				appliedSegments.add(segment.key);
				applied = true;
			}
			if (applied) state.loadMeta(next.meta);
			return applied;
		},

		async setMeta(key: string, value: string): Promise<void> {
			await ready();
			assertOpen();
			state.setMeta(key, value);
			// Meta lives in the manifest, so it is covered by the same linearization
			// point as everything else and needs no second CAS'd object. It is small
			// and rarely written (the compaction cutoff, essentially), so paying a
			// round trip here rather than riding a WAL batch keeps it simple.
			await manifest.commit((next) => {
				next.meta[key] = value;
			});
		},

		// tryLock / unlock are deliberately NOT implemented. They exist so
		// instances sharing one database can serialize maintenance; here a room
		// has exactly one writer by construction, and the manifest CAS already
		// makes a second writer's writes impossible rather than merely unlikely.
		// Implementing them over the manifest would add two round trips to buy
		// mutual exclusion that already holds. `CompactionManager` treats an
		// adapter without them as uncontended, which is exactly right.

		get health(): StorageHealth {
			return wal.health;
		},

		get durableHlc(): string | null {
			return wal.durableHlc;
		},

		onDurable(callback: (hlc: string) => void): void {
			wal.onDurable(callback);
		},

		onHealthChange(callback: (health: StorageHealth) => void): void {
			wal.onHealthChange(callback);
		},

		async flush(): Promise<void> {
			await ready();
			await wal.flush();
		},

		/**
		 * Stop accepting writes, drain, release the lease.
		 *
		 * Releasing on a clean shutdown is what lets `lease.ttlMs` be long, and a
		 * long TTL is what makes idle rooms free — the three decisions are
		 * load-bearing on each other, so dropping the release quietly reintroduces
		 * a `ttlMs` failover stall on every deploy. And on a platform that replaces
		 * machines constantly, a SIGTERM that skips the drain is silent data loss
		 * on every deploy under `durability: "buffered"`.
		 *
		 * Never rejects: a close that throws during teardown leaves timers armed
		 * and the lease held, which is strictly worse than a logged warning.
		 */
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			closing = (async () => {
				// The drain is bounded, and the two ways it can end badly are worth
				// telling apart in a log: a slow store that ran out of shutdown
				// budget is an operational tuning problem, while a fenced or failing
				// writer is a correctness one.
				const outcome = await Promise.race([
					wal.flush().then(
						() => null,
						(error: unknown) => ({ error }),
					),
					clock.delay(resolved.shutdownFlushMs).then(() => "timeout" as const),
				]);
				if (outcome === "timeout") {
					console.warn(
						`[reflectdb] object storage: room "${resolved.roomId}" did not finish ` +
							`flushing within shutdownFlushMs (${resolved.shutdownFlushMs}ms); ` +
							`buffered writes were not made durable.`,
					);
				} else if (outcome) {
					console.warn(
						`[reflectdb] object storage: the final drain for room "${resolved.roomId}" ` +
							`failed; buffered writes were not made durable:`,
						outcome.error,
					);
				}
				// Bounded for the same reason the drain is: an in-flight request
				// cannot be cancelled, so an unbounded wait here would let a hung
				// store hold the process open through a SIGTERM and turn a deploy
				// into a kill-timer wait.
				await wal.stop(resolved.shutdownFlushMs);
				// Before the release, not after. A flush the bounded `stop` above
				// abandoned can still be inside a driver call; when it returns it
				// would find no lease held, re-acquire one, and write into a store
				// this process is done with — resurrecting the lease the next line
				// gives up. `stop()` makes that commit refuse instead.
				manifest.stop();
				// No extra manifest CAS here: the drain above already committed
				// everything buffered, and `setMeta` commits inline. An unconditional
				// final PUT would be a wasted round trip and one more chance to fail
				// while fenced.
				try {
					// Also bounded — the release is a PUT, and a store that just failed
					// to accept the drain is unlikely to accept this either. Skipping
					// it only costs the next writer a `lease.ttlMs` wait, which is the
					// unclean-failover path the TTL exists for.
					await Promise.race([
						manifest.release(),
						clock.delay(resolved.shutdownFlushMs).then(() => {
							console.warn(
								`[reflectdb] object storage: releasing the lease for room ` +
									`"${resolved.roomId}" timed out; the next writer will wait out ` +
									`lease.ttlMs (${resolved.lease.ttlMs}ms) instead.`,
							);
						}),
					]);
				} catch (error) {
					console.warn("[reflectdb] object storage: releasing the lease failed:", error);
				}
				state.dispose();
				try {
					await driver.close?.();
				} catch (error) {
					console.warn("[reflectdb] object storage: closing the driver failed:", error);
				}
			})();
			return closing;
		},
	};

	return adapter;
}
