import type { OpLogEntry, StorageAdapter } from "./handler.ts";
import { ensureAtomicApplyOp } from "./handler.ts";

export interface EagerBufferConfig {
	flushInterval?: number; // ms, default 200
	maxBufferSize?: number; // per query, default 1000
	/**
	 * Called when an op fails to persist. Distinct from console.error so the
	 * application can surface flush failures (DLQ, alerting, metrics) instead
	 * of relying on log scraping. The op stays re-queued at the buffer head
	 * for retry; this hook fires per failed attempt.
	 */
	onFlushError?: (err: unknown, op: BufferedOp) => void;
}

export interface BufferedOp {
	entry: OpLogEntry;
	/**
	 * Resolved row state to write to the row store. May differ from
	 * entry.payload when the op is an UPDATE: payload carries the delta
	 * for the oplog, but row carries the merged result so putRow doesn't
	 * clobber untouched columns. If undefined, defaults to entry.payload.
	 */
	row?: Record<string, unknown> | null;
}

const DEFAULT_FLUSH_INTERVAL = 200;
const DEFAULT_MAX_BUFFER_SIZE = 1000;

export class EagerBuffer {
	private buffers = new Map<string, BufferedOp[]>();
	private flushInterval: number;
	private maxBufferSize: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private storage: StorageAdapter | null = null;
	private flushPromise: Promise<number> | null = null;
	private onFlushError: ((err: unknown, op: BufferedOp) => void) | null = null;

	constructor(config?: EagerBufferConfig) {
		this.flushInterval = config?.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
		this.maxBufferSize = config?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
		this.onFlushError = config?.onFlushError ?? null;
	}

	setOnFlushError(handler: ((err: unknown, op: BufferedOp) => void) | null): void {
		this.onFlushError = handler;
	}

	setStorage(storage: StorageAdapter): void {
		this.storage = ensureAtomicApplyOp(storage);
	}

	start(interval?: number): void {
		const requested = interval ?? this.flushInterval;
		// Floor of 1ms: setInterval(0) becomes a tight loop and wedges the event
		// loop. The flush itself is async + IO-bound so anything below ~10ms is
		// always wasteful, but enforce a hard 1ms minimum to be safe.
		const newInterval = Math.max(1, Math.min(this.flushInterval, requested));

		if (this.timer) {
			// Already running — restart only if new interval is shorter
			if (newInterval < this.flushInterval) {
				clearInterval(this.timer);
				this.flushInterval = newInterval;
				this.timer = setInterval(() => {
					this.flush();
				}, this.flushInterval);
			}
			return;
		}

		this.flushInterval = newInterval;
		this.timer = setInterval(() => {
			this.flush();
		}, this.flushInterval);
	}

	/**
	 * Check if the buffer has capacity for one more op.
	 */
	hasCapacity(queryName: string, maxSize?: number): boolean {
		const buffer = this.buffers.get(queryName);
		if (!buffer) return true;
		return buffer.length < (maxSize ?? this.maxBufferSize);
	}

	/**
	 * Push an op into the buffer. Returns false if the buffer is full (backpressure).
	 * Synchronous — the periodic flush timer handles draining.
	 */
	push(queryName: string, op: BufferedOp, maxSize?: number): boolean {
		let buffer = this.buffers.get(queryName);
		if (!buffer) {
			buffer = [];
			this.buffers.set(queryName, buffer);
		}

		if (buffer.length >= (maxSize ?? this.maxBufferSize)) {
			return false;
		}

		buffer.push(op);
		return true;
	}

	/**
	 * Flush all buffered ops to storage.
	 * If a flush is already in progress, waits for it to complete.
	 */
	async flush(): Promise<number> {
		if (this.flushPromise) {
			return this.flushPromise;
		}

		this.flushPromise = this.doFlush();
		try {
			return await this.flushPromise;
		} finally {
			this.flushPromise = null;
		}
	}

	private async doFlush(): Promise<number> {
		let flushed = 0;

		for (const [name, buffer] of this.buffers) {
			if (buffer.length === 0) continue;

			// Drain buffer
			const ops = buffer.splice(0, buffer.length);

			if (this.storage) {
				const storage = this.storage;
				// applyOp is guaranteed by handler.setStorage (atomic for built-in
				// adapters, shimmed for user adapters with a one-time warning).
				const results = await Promise.allSettled(
					ops.map((op) =>
						storage.applyOp!(
							op.entry.table,
							op.entry.rowId,
							op.row !== undefined ? op.row : op.entry.payload,
							op.entry.colClocks,
							op.entry.hlc,
							op.entry.op,
							op.entry.payload,
						),
					),
				);

				const failedOps: BufferedOp[] = [];
				for (let i = 0; i < results.length; i++) {
					const r = results[i]!;
					if (r.status === "fulfilled") {
						flushed++;
					} else {
						console.error("[reflectdb] EagerBuffer: failed to persist op:", r.reason);
						failedOps.push(ops[i]!);
						if (this.onFlushError) {
							try {
								this.onFlushError(r.reason, ops[i]!);
							} catch (handlerErr) {
								console.error("[reflectdb] EagerBuffer: onFlushError threw:", handlerErr);
							}
						}
					}
				}
				// Re-queue transient failures at the head so the next flush retries.
				// Without this, eager-acked ops would be silently lost on storage
				// hiccups (network blip, lock contention).
				if (failedOps.length > 0) {
					buffer.unshift(...failedOps);
				}
			} else {
				flushed += ops.length;
			}
			void name;
		}

		return flushed;
	}

	/** Number of buffered ops across all queries. */
	get pendingCount(): number {
		let count = 0;
		for (const buffer of this.buffers.values()) {
			count += buffer.length;
		}
		return count;
	}

	/** Number of buffered ops for a specific query. */
	queryPendingCount(queryName: string): number {
		return this.buffers.get(queryName)?.length ?? 0;
	}

	async close(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		// Wait for any in-progress flush to complete before final flush
		if (this.flushPromise) {
			await this.flushPromise;
		}
		// Final flush
		await this.flush();
	}
}
