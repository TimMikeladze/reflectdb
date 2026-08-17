import type { StorageAdapter } from "./handler.ts";
import type { SyncEvent } from "./types.ts";

/**
 * Encapsulates op-log compaction: cross-instance advisory lock, monotonic
 * cutoff persistence, and the "compacted ⇒ permanently lost" contract.
 * Extracted from MessageHandler to keep that class focused on dispatch.
 */
export class CompactionManager {
	/**
	 * Minimum minOpAge we'll honor regardless of caller. Prevents an aggressive
	 * config from compacting ops that live subscriptions are about to consume,
	 * orphaning resuming clients past the cutoff.
	 */
	static readonly MIN_COMPACTION_AGE_MS = 30_000;

	private cutoffHlc: string | null = null;
	private cutoffLoaded = false;

	constructor(
		private storage: StorageAdapter | null,
		private emit: (event: SyncEvent) => void,
	) {}

	setStorage(storage: StorageAdapter): void {
		this.storage = storage;
	}

	getCutoff(): string | null {
		return this.cutoffHlc;
	}

	async ensureCutoffLoaded(): Promise<void> {
		if (this.cutoffLoaded || !this.storage) return;
		this.cutoffLoaded = true;
		const cutoff = await this.storage.getMeta("compactionCutoff");
		if (cutoff) {
			this.cutoffHlc = cutoff;
		}
	}

	async runCompaction(minOpAge: number): Promise<number> {
		if (!this.storage) return 0;

		// Enforce safety floor: never compact ops younger than MIN_COMPACTION_AGE_MS.
		const safeMinAge = Math.max(minOpAge, CompactionManager.MIN_COMPACTION_AGE_MS);

		// HA: acquire cross-instance advisory lock so only one instance compacts
		// at a time.
		const lockKey = "compaction";
		let acquired = true;
		if (this.storage.tryLock) {
			acquired = await this.storage.tryLock(lockKey);
			if (!acquired) {
				this.emit({ type: "compaction", deletedOps: 0 });
				return 0;
			}
		}

		try {
			await this.ensureCutoffLoaded();

			const cutoffMs = Date.now() - safeMinAge;
			const cutoffHlc = String(cutoffMs).padStart(19, "0") + ".9999.compaction";

			// Refuse to move the cutoff backwards.
			if (this.cutoffHlc && cutoffHlc <= this.cutoffHlc) {
				this.emit({ type: "compaction", deletedOps: 0 });
				return 0;
			}

			// Commit cutoff first, then lazily delete ops.
			this.cutoffHlc = cutoffHlc;
			await this.storage.setMeta("compactionCutoff", cutoffHlc);
			const deleted = await this.storage.deleteOpsBefore(cutoffHlc);
			if (deleted > 0) {
				this.emit({ type: "compaction", deletedOps: deleted });
			}
			return deleted;
		} finally {
			if (acquired && this.storage.unlock) {
				await this.storage.unlock(lockKey);
			}
		}
	}
}
