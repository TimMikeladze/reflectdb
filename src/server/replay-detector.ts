import type { StorageAdapter } from "./handler.ts";

/**
 * Atomic replay-detection gate. With storage, delegates to `storage.reserveOp`
 * (HA-safe). Without storage, uses a TTL-bounded in-memory map (single-instance).
 *
 * Returns true when the opId is fresh (first sighting), false on replay.
 */
export class ReplayDetector {
	private static readonly TTL_MS = 5 * 60_000;
	private static readonly MAX_ENTRIES = 10_000;

	private inMemory = new Map<string, number>();

	constructor(private storage: StorageAdapter | null) {}

	setStorage(storage: StorageAdapter): void {
		this.storage = storage;
	}

	async reserve(opId: string): Promise<boolean> {
		if (this.storage) {
			return this.storage.reserveOp(opId);
		}
		const now = Date.now();
		const cutoff = now - ReplayDetector.TTL_MS;
		if (this.inMemory.has(opId)) {
			// Refresh so a recently-replayed opId stays remembered.
			this.inMemory.set(opId, now);
			return false;
		}
		// Lazy TTL sweep: drop expired entries before inserting. Bounded by
		// MAX_ENTRIES to cap worst-case sweep cost.
		if (this.inMemory.size >= ReplayDetector.MAX_ENTRIES) {
			for (const [k, ts] of this.inMemory) {
				if (ts < cutoff) this.inMemory.delete(k);
			}
			// Hard cap fallback: if still oversized after TTL sweep, drop oldest.
			if (this.inMemory.size >= ReplayDetector.MAX_ENTRIES) {
				const iter = this.inMemory.keys();
				const drop = Math.ceil(ReplayDetector.MAX_ENTRIES / 2);
				for (let i = 0; i < drop; i++) {
					const k = iter.next().value;
					if (k === undefined) break;
					this.inMemory.delete(k);
				}
			}
		}
		this.inMemory.set(opId, now);
		return true;
	}
}
