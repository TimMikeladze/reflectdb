/**
 * Contracts for the object-storage backend.
 *
 * Design: docs/object-storage.md. The short version — the object store is the
 * only durable store, but it is never on the read path. State is authoritative
 * in memory; writes append to a buffer that group-commits one object per batch;
 * a CAS'd manifest is the linearization point.
 *
 * Nothing in this directory may statically import a `node:` builtin. `bunup`
 * builds `src/` with `target: "browser"`, and a `node:` import anywhere here is
 * hoisted into a shared chunk that every entry point — including
 * `reflectdb/core` and `reflectdb/react` — side-effect-imports, which breaks
 * consumer bundles outright. Use `src/server/node-require.ts` when a builtin is
 * genuinely needed (the filesystem driver), and WebCrypto rather than
 * `node:crypto` everywhere else.
 */

// ── driver ────────────────────────────────────────────────────────────────

/** A stored object plus the etag needed to CAS against it. */
export interface ObjectRecord {
	body: Uint8Array;
	etag: string;
}

export interface ObjectPutOptions {
	/**
	 * Overwrite only if the current etag matches. A mismatch throws
	 * `PreconditionFailedError`. This is the CAS primitive the manifest and
	 * lease are built on.
	 */
	ifMatch?: string;
	/**
	 * Write only if the key is absent. Only `"*"` is meaningful, matching the S3
	 * header. Drivers reporting `caps.casWildcard === false` (MinIO) reject this
	 * — see `ObjectDriverCapabilities.casWildcard`.
	 */
	ifNoneMatch?: "*";
}

export interface ObjectListEntry {
	key: string;
	size: number;
}

export interface ObjectDriverCapabilities {
	/**
	 * Whether `ifNoneMatch: "*"` (create-if-absent) is supported.
	 *
	 * MinIO shipped conditional writes before AWS but requires an exact etag and
	 * rejects the wildcard, so create-if-absent is unavailable there. Stores on a
	 * driver reporting `false` require a one-time `init()` that unconditionally
	 * seeds `_lease` and `_manifest`; every later write is a plain `ifMatch`,
	 * which MinIO handles fine.
	 *
	 * `init()` is a deploy step. Racing it from N servers on a non-wildcard
	 * driver is unsafe.
	 */
	casWildcard: boolean;
}

/**
 * The whole provider surface. Four methods — everything above this interface is
 * provider-agnostic and never learns which store it is talking to.
 *
 * Keys are store-relative; the driver owns bucket and prefix.
 */
export interface ObjectDriver {
	/** Returns `null` when the key is absent — absence is not an error. */
	get(key: string): Promise<ObjectRecord | null>;
	/**
	 * Writes `body` and returns the new etag.
	 *
	 * @throws {PreconditionFailedError} when `ifMatch` / `ifNoneMatch` fails.
	 */
	put(key: string, body: Uint8Array, opts?: ObjectPutOptions): Promise<string>;
	/** Lists keys under `prefix`. Must page internally and return the full set. */
	list(prefix: string): Promise<ObjectListEntry[]>;
	/** Deletes keys. Absent keys are not an error. */
	delete(keys: string[]): Promise<void>;
	readonly caps: ObjectDriverCapabilities;
	/** Releases any pooled resources. Optional. */
	close?(): Promise<void> | void;
}

// ── errors ────────────────────────────────────────────────────────────────

/**
 * A conditional write lost. Callers treat this as "someone else moved first",
 * never as a transport failure — retrying without re-reading is always wrong.
 */
export class PreconditionFailedError extends Error {
	readonly key: string;
	constructor(key: string, message?: string) {
		super(message ?? `Conditional write failed for "${key}" (etag mismatch)`);
		this.name = "PreconditionFailedError";
		this.key = key;
	}
}

/** The write buffer exceeded `batch.maxBufferBytes` under `onBackpressure: "reject"`. */
export class BackpressureError extends Error {
	readonly bufferedBytes: number;
	readonly limitBytes: number;
	constructor(bufferedBytes: number, limitBytes: number) {
		super(
			`Object storage write buffer is full (${bufferedBytes} > ${limitBytes} bytes). ` +
				`The object store is not keeping up; the write was rejected so backpressure ` +
				`reaches the client. Set batch.onBackpressure to "degrade" to accept writes ` +
				`without a durability guarantee instead.`,
		);
		this.name = "BackpressureError";
		this.bufferedBytes = bufferedBytes;
		this.limitBytes = limitBytes;
	}
}

/** In-memory state exceeded the configured budget under `memory.onExceeded: "reject"`. */
export class MemoryLimitExceededError extends Error {
	readonly usedBytes: number;
	readonly limitBytes: number;
	constructor(usedBytes: number, limitBytes: number) {
		super(
			`Object storage room state exceeded its memory budget ` +
				`(${usedBytes} > ${limitBytes} bytes). State is authoritative in memory, so ` +
				`this is a hard ceiling rather than a slowdown. Raise memory.maxRoomBytes, ` +
				`shard the room, or wait for memory.onExceeded: "spill".`,
		);
		this.name = "MemoryLimitExceededError";
		this.usedBytes = usedBytes;
		this.limitBytes = limitBytes;
	}
}

/**
 * This instance is not the writer for the room: another holds an unexpired
 * lease, or a renewal failed and the writer self-fenced.
 */
export class NotWriterError extends Error {
	readonly roomId: string;
	constructor(roomId: string, detail?: string) {
		super(`Not the writer for room "${roomId}"${detail ? `: ${detail}` : ""}`);
		this.name = "NotWriterError";
		this.roomId = roomId;
	}
}

// ── persisted shapes ──────────────────────────────────────────────────────

/**
 * The lease object. CAS'd on every acquire and renew; `epoch` is the fencing
 * token stamped into every WAL segment name and manifest write.
 */
export interface LeaseRecord {
	owner: string;
	epoch: number;
	/** Wall-clock ms. Coarse by design — the manifest CAS is the real guard. */
	expiresAt: number;
}

export interface WalSegmentRef {
	key: string;
	epoch: number;
	seq: number;
	bytes: number;
	/** Highest HLC in the segment; lets replay skip segments below a snapshot. */
	maxHlc: string;
}

/**
 * The single CAS'd linearization point. Every field a booting reader needs to
 * reconstruct state is here, so boot is one GET plus the objects it names.
 */
export interface ManifestRecord {
	version: 1;
	epoch: number;
	/**
	 * Increments on every commit. Exists solely to make the manifest bytes differ
	 * on every write, which closes an ABA hole in etag-based CAS.
	 *
	 * S3 derives an etag from object content, so writing identical bytes leaves
	 * the etag unchanged. Without this counter a writer could read etag E, have
	 * another writer commit a manifest that happens to serialize identically, and
	 * still win its `ifMatch: E` — a lost update that no 412 reports. In practice
	 * `oplogHead` and `walSegs` almost always differ, but "almost always" is not
	 * a property to rest a linearization point on. A monotonic counter makes it
	 * impossible by construction rather than by luck.
	 */
	commitSeq: number;
	/**
	 * `writerId` of whoever wrote this version.
	 *
	 * Together with `commitSeq` it identifies a commit uniquely, which is what
	 * lets a writer that took a 412 tell "my own write, acknowledged late" from
	 * "someone else got there first". `epoch` cannot do that job under
	 * `concurrency: "optimistic"`: there is no lease, so every instance shares the
	 * manifest's epoch and two of them will attempt the same `commitSeq` — making
	 * an epoch-based check adopt a rival's commit as your own and silently drop
	 * the segment you just wrote.
	 */
	lastWriter: string;
	/** Key of the newest snapshot, or `null` before the first compaction. */
	snapshotKey: string | null;
	/** Highest HLC covered by the snapshot; segments at or below it are replaceable. */
	snapshotHlc: string | null;
	/** Segments to replay after the snapshot, in commit order. */
	walSegs: WalSegmentRef[];
	/** Highest HLC committed anywhere in the log. */
	oplogHead: string | null;
	/** `getMeta` / `setMeta` storage. Small by contract. */
	meta: Record<string, string>;
	/** Segments superseded by compaction, deleted once `gcGraceMs` has elapsed. */
	pendingGc: { key: string; deletableAt: number }[];
}

/** A materialized row, mirroring `ExistingRow` plus its id. */
export interface SnapshotRow {
	table: string;
	rowId: string;
	row: Record<string, unknown>;
	colClocks: Record<string, string>;
	hlc: string;
}

export interface SnapshotRecord {
	version: 1;
	hlc: string | null;
	rows: SnapshotRow[];
	/** Op ids still inside the replay-protection window, with their timestamps. */
	reservedOps: [opId: string, atMs: number][];
}

// ── configuration ─────────────────────────────────────────────────────────

export type StoreProvider = "aws" | "r2" | "tigris" | "minio" | "gcs";

export interface StoreCredentials {
	keyId: string;
	secret: string;
	sessionToken?: string;
}

export interface StoreConfig {
	/** Fills `endpoint` and `urlStyle` when they are not given explicitly. */
	provider?: StoreProvider;
	bucket: string;
	prefix?: string;
	endpoint?: string;
	region?: string;
	urlStyle?: "vhost" | "path";
	credentials: StoreCredentials;
	/** Cloudflare R2 account id; only used to derive the endpoint for `provider: "r2"`. */
	accountId?: string;
}

export type DurabilityMode = "durable" | "buffered";
export type BackpressurePolicy = "reject" | "degrade";
export type MemoryPolicy = "reject" | "evict" | "spill";
export type LeaseMode = "always" | "on-write";

/**
 * How this process expects to share the room with other processes.
 *
 * `"single-writer"` (default) is the design in docs/object-storage.md: one
 * writer per room, elected by a lease, holding authoritative state in memory.
 * Reads never touch the network and a write is one segment PUT plus one CAS.
 * It requires the deployment to route a room to one instance.
 *
 * `"optimistic"` drops the lease for platforms that cannot make that promise —
 * Vercel functions, or anything where any request may land on any instance. It
 * rests on the same guarantee the single-writer mode does: the manifest CAS is
 * what keeps the data correct, and the lease was only ever an optimization to
 * stop two servers doing redundant work. Concurrent writers race on the CAS,
 * the loser re-reads and retries, and nobody is fenced.
 *
 * What it costs: in-memory state is no longer authoritative, because another
 * instance may have committed since this one last looked. Call `refresh()`
 * before serving a read that must be current — one conditional GET of the
 * manifest, which is why the poll loop in a serverless deployment is cheap.
 */
export type ConcurrencyMode = "single-writer" | "optimistic";
export type StorageHealth = "healthy" | "degraded" | "unavailable";

export interface BatchConfig {
	maxBytes?: number;
	/** Coalesces ops arriving in the same event-loop tick. Not a flush interval. */
	minLingerMs?: number;
	maxBufferBytes?: number;
	onBackpressure?: BackpressurePolicy;
}

export interface CompactionConfig {
	afterSegments?: number;
	afterBytes?: number;
	/** Delay before deleting superseded segments, so in-flight readers do not 404. */
	gcGraceMs?: number;
}

export interface LeaseConfig {
	ttlMs?: number;
	renewMs?: number;
	mode?: LeaseMode;
}

export interface MemoryConfig {
	maxTotalBytes?: number;
	maxRoomBytes?: number;
	onExceeded?: MemoryPolicy;
	idleEvictMs?: number;
}

export interface ObjectStorageConfig {
	/** A ready driver, or a `StoreConfig` from which the S3 driver is built. */
	driver?: ObjectDriver;
	store?: StoreConfig;
	roomId: string;
	/**
	 * Identifies this writer in the lease. Defaults to a random id; set it
	 * explicitly to make lease ownership legible in logs.
	 */
	writerId?: string;

	/**
	 * `"durable"` (default) acks after the manifest CAS — correct with no
	 * protocol change. `"buffered"` acks on memory apply and is LOSSY until the
	 * durable-watermark protocol lands: a crash before flush drops ops the client
	 * has already retired. See docs/object-storage.md.
	 */
	durability?: DurabilityMode;
	retentionMs?: number;
	/**
	 * Defaults to `"single-writer"`. Set `"optimistic"` on a platform that cannot
	 * route a room to one instance — see `ConcurrencyMode`.
	 */
	concurrency?: ConcurrencyMode;

	batch?: BatchConfig;
	compaction?: CompactionConfig;
	lease?: LeaseConfig;
	memory?: MemoryConfig;
	shutdownFlushMs?: number;

	/** Fired after each batch reaches durability. Phase 2 broadcasts this to clients. */
	onDurable?: (hlc: string) => void;
	onHealthChange?: (health: StorageHealth) => void;
}

/** Every knob resolved. Internals read this, never the optional-laden input. */
export interface ResolvedObjectStorageConfig {
	roomId: string;
	writerId: string;
	durability: DurabilityMode;
	retentionMs: number;
	concurrency: ConcurrencyMode;
	batch: Required<BatchConfig>;
	compaction: Required<CompactionConfig>;
	lease: Required<LeaseConfig>;
	memory: Required<MemoryConfig>;
	shutdownFlushMs: number;
}

export const OBJECT_STORAGE_DEFAULTS = {
	durability: "durable" as DurabilityMode,
	retentionMs: Number.POSITIVE_INFINITY,
	concurrency: "single-writer" as ConcurrencyMode,
	batch: {
		maxBytes: 4 * 1024 * 1024,
		minLingerMs: 5,
		maxBufferBytes: 64 * 1024 * 1024,
		onBackpressure: "reject" as BackpressurePolicy,
	},
	compaction: {
		afterSegments: 200,
		afterBytes: 64 * 1024 * 1024,
		gcGraceMs: 60 * 60 * 1000,
	},
	lease: {
		ttlMs: 5 * 60 * 1000,
		renewMs: 2 * 60 * 1000,
		mode: "on-write" as LeaseMode,
	},
	memory: {
		maxTotalBytes: Number.POSITIVE_INFINITY,
		maxRoomBytes: Number.POSITIVE_INFINITY,
		onExceeded: "reject" as MemoryPolicy,
		idleEvictMs: 5 * 60 * 1000,
	},
	shutdownFlushMs: 5000,
} as const;
