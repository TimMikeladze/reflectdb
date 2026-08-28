/**
 * Group-commit WAL writer for the object-storage backend.
 *
 * There is no `flushMs` knob, and that is the central design decision rather
 * than an omission. The loop is self-clocking — the same trick Postgres group
 * commit and Kafka's linger use — and it holds exactly ONE flush in flight at a
 * time:
 *
 *     while (running) {
 *       await waitNonEmpty();        // idle blocks here: no timer, no PUT
 *       await delay(minLingerMs);    // coalesce ops from the same tick
 *       put(segment); casManifest(); // one round trip
 *     }
 *
 * That single in-flight constraint is what makes it adapt with no
 * configuration:
 *
 * - Low write rate: the buffer holds one record, the flush fires immediately,
 *   and latency is exactly one store round trip. Optimal.
 * - High write rate: records accumulate *during* the in-flight flush, so the
 *   next batch is naturally as large as the round trip allows. Throughput is
 *   `maxBytes / rtt`. Optimal.
 * - Idle: the loop blocks on a promise. Zero PUTs, zero timers, zero cost.
 *
 * Batch size therefore auto-tracks the store's latency: a slow provider batches
 * harder, and a fast one (S3 Express, a Tigris bucket colocated with Fly)
 * batches less. Exposing `flushMs` would invite someone to set 10ms, quadruple
 * their PUT bill and gain no latency, so it is deliberately not a knob.
 *
 * `minLingerMs` (5ms) is not a flush interval. It exists only to coalesce
 * records that arrive in the same event-loop tick, which costs no latency that
 * a network round trip does not already dwarf.
 */

import { BackpressureError, NotWriterError } from "./types.ts";
import type {
	BatchConfig,
	ConcurrencyMode,
	DurabilityMode,
	ObjectDriver,
	StorageHealth,
	WalSegmentRef,
} from "./types.ts";
import { recordHlc, systemClock } from "./state.ts";
import type { Clock, WalRecord } from "./state.ts";
import type { ManifestStore } from "./manifest.ts";
import { roomPrefix } from "./manifest.ts";

/**
 * Consecutive flush failures before health drops from "degraded" to
 * "unavailable". The first failure is often a retryable blip; three in a row
 * with exponential backoff between them is an outage, and the app needs to stop
 * showing a happy UI.
 */
const UNAVAILABLE_AFTER_FAILURES = 3;

const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 10_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Newline-delimited JSON, one `WalRecord` per line. */
export function encodeSegment(lines: string[]): Uint8Array {
	return encoder.encode(lines.join("\n"));
}

export function decodeSegment(body: Uint8Array, key: string): WalRecord[] {
	const text = decoder.decode(body);
	const records: WalRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		try {
			records.push(JSON.parse(line) as WalRecord);
		} catch (error) {
			// A truncated final line would mean a partially written object, which
			// the store's atomic PUT makes impossible — so a parse failure here is
			// corruption, not a torn write, and skipping it would silently drop
			// acknowledged writes.
			throw new Error(
				`Object storage: WAL segment "${key}" contains an unparsable record. ` +
					`Refusing to boot with a partial log. (${String(error)})`,
			);
		}
	}
	return records;
}

/** A record that has passed the backpressure check and is ready to append. */
export interface PreparedRecord {
	readonly record: WalRecord;
	readonly line: string;
	readonly bytes: number;
	readonly hlc: string;
	/**
	 * False when the write was admitted past `maxBufferBytes` under
	 * `onBackpressure: "degrade"`. It still flushes; it just is not waited on.
	 */
	readonly durable: boolean;
}

interface Buffered extends PreparedRecord {
	resolve: () => void;
	reject: (error: unknown) => void;
	settled: boolean;
}

interface Waiter {
	resolve: () => void;
	reject: (error: unknown) => void;
}

export interface WalWriterOptions {
	driver: ObjectDriver;
	manifest: ManifestStore;
	roomId: string;
	batch: Required<BatchConfig>;
	durability: DurabilityMode;
	concurrency?: ConcurrencyMode;
	/** Identifies this instance. In `"optimistic"` it is what makes segment names unique. */
	writerId?: string;
	clock?: Clock;
	/** Runs after each committed batch, inside the loop. Compaction hooks here. */
	onCommitted?: () => Promise<void>;
}

export class WalWriter {
	private readonly driver: ObjectDriver;
	private readonly manifest: ManifestStore;
	private readonly batch: Required<BatchConfig>;
	private readonly durability: DurabilityMode;
	private readonly concurrency: ConcurrencyMode;
	private readonly writerId: string;
	private readonly clock: Clock;
	private readonly prefix: string;
	private readonly onCommitted: (() => Promise<void>) | undefined;

	private buffer: Buffered[] = [];
	private bufferedBytes = 0;
	private seq = 0;
	private seqEpoch = -1;

	private running = false;
	private stopped = false;
	private loop: Promise<void> | null = null;
	private wakeWaiter: (() => void) | null = null;
	private stopSignal: Promise<void>;
	private releaseStopSignal: () => void = () => {};
	private forced = false;
	private flushWaiters: Waiter[] = [];

	private failures = 0;
	private backpressured = false;
	private currentHealth: StorageHealth = "healthy";
	private terminal: unknown = null;
	private durableHead: string | null = null;

	private readonly durableListeners: ((hlc: string) => void)[] = [];
	private readonly healthListeners: ((health: StorageHealth) => void)[] = [];

	constructor(options: WalWriterOptions) {
		this.driver = options.driver;
		this.manifest = options.manifest;
		this.batch = options.batch;
		this.durability = options.durability;
		this.concurrency = options.concurrency ?? "single-writer";
		this.writerId = options.writerId ?? "writer";
		this.clock = options.clock ?? systemClock;
		this.prefix = roomPrefix(options.roomId);
		this.onCommitted = options.onCommitted;
		this.stopSignal = new Promise((resolve) => {
			this.releaseStopSignal = resolve;
		});
	}

	get health(): StorageHealth {
		return this.currentHealth;
	}

	/** Highest HLC that has reached durability. Phase 2 broadcasts this. */
	get durableHlc(): string | null {
		return this.durableHead;
	}

	get bufferBytes(): number {
		return this.bufferedBytes;
	}

	onDurable(callback: (hlc: string) => void): void {
		this.durableListeners.push(callback);
	}

	onHealthChange(callback: (health: StorageHealth) => void): void {
		this.healthListeners.push(callback);
	}

	start(): void {
		if (this.running || this.stopped) return;
		this.running = true;
		// The loop promise never rejects. A bounded `stop()` may abandon it, and
		// an abandoned rejecting promise is an unhandled rejection that surfaces
		// long after the adapter stopped being anyone's concern.
		this.loop = this.run().catch((error: unknown) => {
			console.warn("[reflectdb] object storage: the WAL flush loop exited abnormally:", error);
		});
	}

	// ── enqueue ───────────────────────────────────────────────────────────

	/**
	 * Serializes a record and admits it against the buffer budget.
	 *
	 * Split from `append` on purpose. The caller mutates authoritative memory
	 * between the two, and a rejected write must leave no trace there — so the
	 * throw has to happen BEFORE the mutation, not after it. There is no `await`
	 * between the two calls, which is what makes the pair atomic.
	 *
	 * @throws {BackpressureError} under `onBackpressure: "reject"`.
	 */
	prepare(record: WalRecord): PreparedRecord {
		this.assertWritable();
		const line = JSON.stringify(record);
		const bytes = line.length + 1; // + the newline separator
		let durable = this.durability === "durable";

		if (this.bufferedBytes + bytes > this.batch.maxBufferBytes) {
			if (this.batch.onBackpressure === "reject") {
				// Backpressure propagates to the client, which retries. An
				// undefined policy here means "OOM during a store outage" instead.
				throw new BackpressureError(this.bufferedBytes + bytes, this.batch.maxBufferBytes);
			}
			// "degrade": keep accepting, stop promising durability, say so in
			// `health` so the app can render "not saved" rather than lying.
			this.setBackpressured(true);
			durable = false;
		}

		return { record, line, bytes, hlc: recordHlc(record), durable };
	}

	/**
	 * Buffers a prepared record and returns when it is durable.
	 *
	 * Under `durability: "buffered"` the promise is already resolved — the ack
	 * happens on the memory apply and the flush still happens behind it. That
	 * mode is LOSSY until the durable-watermark protocol lands, which is why
	 * `"durable"` is the default: acking a write the store has not accepted, to
	 * a client that then retires the op from its pending queue, deletes the
	 * user's data on the next crash and leaves nothing to replay.
	 */
	append(prepared: PreparedRecord): Promise<void> {
		this.assertWritable();
		this.bufferedBytes += prepared.bytes;
		let resolve: () => void = () => {};
		let reject: (error: unknown) => void = () => {};
		const settled = !prepared.durable;
		const promise = settled
			? Promise.resolve()
			: new Promise<void>((res, rej) => {
					resolve = res;
					reject = rej;
				});
		this.buffer.push({ ...prepared, resolve, reject, settled });
		this.start();
		this.wake();
		return promise;
	}

	enqueue(record: WalRecord): Promise<void> {
		return this.append(this.prepare(record));
	}

	/** Forces a drain and resolves once the buffer is empty. */
	flush(): Promise<void> {
		if (this.terminal) return Promise.reject(this.terminal);
		if (this.buffer.length === 0) return Promise.resolve();
		// After `stop()` the loop is gone and `start()` below would no-op, so a
		// waiter registered here could never be settled by anything. Reject rather
		// than hang — the records genuinely will not be written.
		if (this.stopped) {
			return Promise.reject(
				new Error(
					`Object storage: flush() called after the adapter was closed, with ` +
						`${this.buffer.length} record(s) still buffered. They were not made durable.`,
				),
			);
		}
		this.forced = true;
		this.start();
		this.wake();
		return new Promise<void>((resolve, reject) => {
			this.flushWaiters.push({ resolve, reject });
		});
	}

	/**
	 * Halts the loop. Buffered records are NOT flushed — call `flush()` first.
	 *
	 * `timeoutMs` bounds how long we wait for the loop to notice. Clearing
	 * `running` and cutting the stop signal ends every wait the loop owns, but it
	 * cannot cancel a request already inside `driver.put`: `fetch` is in flight
	 * and the store decides when it answers. Without a bound, a hung or very slow
	 * store makes `close()` — and therefore a SIGTERM during a deploy — block
	 * until the platform's kill timer fires, which is a worse outcome than
	 * abandoning a loop that is already unable to make progress. The loop exits
	 * on its own once that request settles; nothing is left half-written, because
	 * a segment PUT is a single write and the manifest only advances after it.
	 */
	async stop(timeoutMs?: number): Promise<void> {
		this.stopped = true;
		if (!this.running && !this.loop) return;
		this.running = false;
		this.releaseStopSignal();
		this.wake();
		const settled = this.loop?.catch(() => undefined);
		if (settled) {
			await (timeoutMs === undefined
				? settled
				: Promise.race([settled, this.clock.delay(timeoutMs)]));
		}
		this.loop = null;

		// Anything still buffered will never be written now, so every outstanding
		// `flush()` waiter has to be told. `settleFlushWaiters` returns early while
		// the buffer is non-empty — correct during normal operation, fatal here —
		// so a caller doing `const p = storage.flush(); await storage.close();`
		// would otherwise wait on a promise that can never settle, and an app
		// awaiting `flush()` in its SIGTERM handler would hang until the platform's
		// kill timer. Rejecting is right rather than resolving: the records did NOT
		// reach the store.
		if (this.buffer.length > 0 && this.flushWaiters.length > 0) {
			const error =
				this.terminal ??
				new Error(
					`Object storage: the adapter was closed with ${this.buffer.length} record(s) still ` +
						`buffered; they were not made durable. Increase shutdownFlushMs, or check ` +
						`storage health — the store was not accepting writes.`,
				);
			const waiters = this.flushWaiters;
			this.flushWaiters = [];
			for (const waiter of waiters) waiter.reject(error);
		}
	}

	// ── the loop ──────────────────────────────────────────────────────────

	private async run(): Promise<void> {
		while (this.running) {
			if (this.buffer.length === 0) {
				this.settleFlushWaiters();
				await this.waitNonEmpty();
				if (!this.running) break;
				if (this.buffer.length === 0) continue;
			}
			// Skipped when a caller forced a flush or a shutdown is draining: the
			// linger only exists to coalesce same-tick arrivals, and there are no
			// more arrivals coming in either case.
			if (this.batch.minLingerMs > 0 && !this.forced) {
				await this.interruptibleDelay(this.batch.minLingerMs);
			}
			await this.flushOnce();
		}
		this.settleFlushWaiters();
	}

	private async flushOnce(): Promise<void> {
		// The loop only calls this with a non-empty buffer, and nothing drains the
		// buffer between that check and here. Asserted locally anyway: were the
		// invariant ever broken, the fall-through would PUT a zero-record segment
		// and push a ref to it into the manifest, which replay would then dutifully
		// fetch on every boot forever.
		if (this.buffer.length === 0) return;

		// The lease is taken here rather than at construction: under
		// `lease.mode: "on-write"` a room with connected clients but no writes
		// must issue zero PUTs, and the epoch has to be settled before the
		// segment can be named.
		let epoch: number;
		try {
			await this.manifest.ensureWriter();
			epoch = this.manifest.epoch;
		} catch (error) {
			await this.onFlushError(error);
			return;
		}

		if (epoch !== this.seqEpoch) {
			// A new epoch restarts the sequence. Names stay unique because the
			// epoch is strictly monotonic, which is also what makes a zombie
			// writer's segments identifiable as orphans.
			this.seqEpoch = epoch;
			this.seq = 0;
		}

		let count = 0;
		let bytes = 0;
		let maxHlc = "";
		const lines: string[] = [];
		for (const item of this.buffer) {
			// `count > 0` so a single record larger than `maxBytes` still goes out
			// on its own rather than wedging the buffer forever.
			if (count > 0 && bytes + item.bytes > this.batch.maxBytes) break;
			bytes += item.bytes;
			lines.push(item.line);
			if (item.hlc > maxHlc) maxHlc = item.hlc;
			count++;
		}

		const seq = this.seq;
		// The name has to be unique across every process that can write this room,
		// because the PUT is unconditional. Under `"single-writer"` the fencing
		// epoch supplies that: only one instance holds a given epoch, and taking
		// the lease bumps it. Under `"optimistic"` there is no lease and every
		// instance shares the manifest's epoch, so the epoch guarantees nothing —
		// two instances would both write `wal/0-0.jsonl` and one would silently
		// overwrite the other's acknowledged records. The per-instance `writerId`
		// is what restores uniqueness there.
		//
		// Ordering does not depend on the name either way: replay follows the
		// `walSegs` array, whose order is the order the CAS accepted the commits.
		const token = this.concurrency === "optimistic" ? this.writerId : String(epoch);
		const key = `${this.prefix}wal/${token}-${seq}.jsonl`;
		const body = encodeSegment(lines);
		const ref: WalSegmentRef = { key, epoch, seq, bytes: body.length, maxHlc };

		// Burn the sequence number BEFORE the PUT, not after the commit.
		//
		// Advancing it only on success means a retry after a failed manifest CAS
		// reuses the same key — with a different body, because more records have
		// been buffered in the meantime. If the earlier attempt's segment PUT
		// landed and only the manifest step failed, that rewrite overwrites an
		// object the durable manifest already references, breaking the
		// "everything but _lease and _manifest is write-once" invariant the whole
		// layout rests on: a concurrent reader can then get either body, and the
		// recorded `bytes` / `maxHlc` no longer describe the object.
		//
		// Sequence numbers are free; abandoning one on a retry costs nothing but a
		// gap, and the manifest names every segment it cares about, so a gap is
		// invisible to readers.
		this.seq++;

		try {
			// The segment name is unique — never reused, even across retries — so
			// this PUT needs no condition, which keeps the hot path to one
			// unconditional write plus one CAS.
			await this.driver.put(key, body);
			await this.manifest.commit((manifest) => {
				manifest.walSegs.push(ref);
				// `maxHlc` is empty when the batch carried no mutation — a batch of
				// `reserve` records alone. Advancing `oplogHead` to `""` there would
				// both lose the real head and tell a resuming client the room changed
				// when nothing did.
				if (maxHlc && (!manifest.oplogHead || maxHlc > manifest.oplogHead)) {
					manifest.oplogHead = maxHlc;
				}
			});
		} catch (error) {
			// The batch is NOT dropped. Records stay buffered, every pending waiter
			// stays pending, and the next pass retries the same set. Losing
			// acked-but-unflushed writes is the exact failure this whole design
			// exists to prevent, and a `catch` that discarded the batch here would
			// reintroduce it behind a "handled" error path.
			await this.onFlushError(error);
			return;
		}

		const committed = this.buffer.splice(0, count);
		this.bufferedBytes -= bytes;
		if (this.bufferedBytes <= this.batch.maxBufferBytes) this.setBackpressured(false);
		for (const item of committed) {
			if (!item.settled) {
				item.settled = true;
				item.resolve();
			}
		}

		this.failures = 0;
		this.setHealth(this.backpressured ? "degraded" : "healthy");
		if (maxHlc && (!this.durableHead || maxHlc > this.durableHead)) {
			this.durableHead = maxHlc;
			for (const listener of this.durableListeners) listener(maxHlc);
		}
		if (this.buffer.length === 0) {
			this.forced = false;
			this.settleFlushWaiters();
		}

		if (this.onCommitted) {
			try {
				await this.onCommitted();
			} catch (error) {
				// Compaction is an optimization; failing it must not fail the writes
				// that already committed. Boot gets slower, nothing is lost.
				console.warn("[reflectdb] object storage: post-commit maintenance failed:", error);
			}
		}
	}

	private async onFlushError(error: unknown): Promise<void> {
		if (error instanceof NotWriterError) {
			// Terminal, not transient. This writer's fence is gone, so the batch can
			// never land from this process — retrying would spin forever while every
			// caller waits on a promise that can never resolve. Fail them loudly
			// instead: the ops are still in the clients' pending queues, and a
			// rejected write is recoverable where a silently stalled one is not.
			this.fail(error);
			return;
		}
		this.failures++;
		this.setHealth(this.failures >= UNAVAILABLE_AFTER_FAILURES ? "unavailable" : "degraded");
		const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1));
		await this.interruptibleDelay(backoff);
	}

	private fail(error: unknown): void {
		this.terminal = error;
		this.running = false;
		this.setHealth("unavailable");
		const pending = this.buffer;
		this.buffer = [];
		this.bufferedBytes = 0;
		for (const item of pending) {
			if (!item.settled) {
				item.settled = true;
				item.reject(error);
			}
		}
		const waiters = this.flushWaiters;
		this.flushWaiters = [];
		for (const waiter of waiters) waiter.reject(error);
		this.releaseStopSignal();
		this.wake();
	}

	// ── internals ─────────────────────────────────────────────────────────

	private assertWritable(): void {
		if (this.terminal) throw this.terminal;
		if (this.stopped) {
			throw new Error("Object storage: the WAL writer is stopped; the adapter was closed.");
		}
	}

	private wake(): void {
		const waiter = this.wakeWaiter;
		this.wakeWaiter = null;
		waiter?.();
	}

	private waitNonEmpty(): Promise<void> {
		if (this.buffer.length > 0 || !this.running) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.wakeWaiter = resolve;
		});
	}

	/** A delay that a `stop()` cuts short, so shutdown is not held up by backoff. */
	private async interruptibleDelay(ms: number): Promise<void> {
		await Promise.race([this.clock.delay(ms), this.stopSignal]);
	}

	private settleFlushWaiters(): void {
		if (this.buffer.length > 0) return;
		this.forced = false;
		const waiters = this.flushWaiters;
		this.flushWaiters = [];
		for (const waiter of waiters) waiter.resolve();
	}

	private setBackpressured(value: boolean): void {
		if (this.backpressured === value) return;
		this.backpressured = value;
		if (this.failures === 0) this.setHealth(value ? "degraded" : "healthy");
	}

	private setHealth(health: StorageHealth): void {
		// Only on an actual transition. Firing per tick would make the callback a
		// hot path and make "degraded" unreadable in logs.
		if (this.currentHealth === health) return;
		this.currentHealth = health;
		for (const listener of this.healthListeners) listener(health);
	}
}
