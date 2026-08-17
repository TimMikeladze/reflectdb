import { createHlc, packHlc, receiveHlc, sendHlc, unpackHlc } from "../core/hlc.ts";
import type { HLC } from "../core/hlc.ts";
import type { StorageAdapter } from "./handler.ts";

/**
 * Meta key holding the highest server HLC this deployment has stamped.
 * Shared across instances that share storage.
 */
export const SERVER_HLC_META_KEY = "serverHlcWatermark";

/** Throttle window for watermark writes. */
const HLC_PERSIST_INTERVAL_MS = 1_000;

/**
 * How far ahead of the current clock the watermark is written. A crash loses
 * at most the un-persisted window, so the lease must cover it — otherwise the
 * restarted instance resumes BEHIND HLCs it already sent, and clients silently
 * drop every delta below their watermark.
 */
const HLC_PERSIST_LEASE_MS = 5_000;

/**
 * The server's hybrid logical clock, made durable.
 *
 * An in-memory-only clock resets to zero on restart and recovers only via
 * `Date.now()`. A backwards NTP step then makes broadcast HLCs regress and
 * clients drop legitimate deltas; across instances, one lagging wall clock does
 * the same thing continuously. This persists a watermark (throttled, with a
 * lease ahead of now) and merges it on boot — and on demand, so HA deployments
 * can converge peers that drift apart.
 */
export class ServerClock {
	private hlc: HLC;
	private storage: StorageAdapter | null = null;
	private load: Promise<void> | null = null;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private persistPending = false;

	constructor(nodeId: string) {
		this.hlc = createHlc(nodeId);
	}

	setStorage(storage: StorageAdapter): void {
		this.storage = storage;
		// Recover the clock before the first message is served.
		this.load = null;
		void this.ensureLoaded();
	}

	/** Current clock value. Read-only snapshot — use `stamp`/`receive` to advance. */
	current(): HLC {
		return this.hlc;
	}

	/** Merge the persisted watermark into this instance's clock, once. */
	ensureLoaded(): Promise<void> {
		if (!this.storage) return Promise.resolve();
		if (this.load) return this.load;
		const storage = this.storage;
		this.load = (async () => {
			try {
				const stored = await storage.getMeta(SERVER_HLC_META_KEY);
				if (stored) this.hlc = receiveHlc(this.hlc, unpackHlc(stored));
			} catch (err) {
				console.error("[reflectdb] Failed to load persisted server HLC watermark:", err);
			}
		})();
		return this.load;
	}

	/**
	 * Re-read the shared watermark and merge it in. Multi-instance deployments
	 * call this periodically (the HA poll loop does) so a lagging instance can't
	 * stamp writes below what its peers already broadcast.
	 */
	async refresh(): Promise<void> {
		if (!this.storage) return;
		try {
			const stored = await this.storage.getMeta(SERVER_HLC_META_KEY);
			if (stored) this.hlc = receiveHlc(this.hlc, unpackHlc(stored));
		} catch (err) {
			console.error("[reflectdb] Failed to refresh server HLC watermark:", err);
		}
	}

	/** Bump the clock, schedule a watermark write, return the packed HLC. */
	stamp(): string {
		this.hlc = sendHlc(this.hlc);
		this.schedulePersist();
		return packHlc(this.hlc);
	}

	/** Peek at the next HLC without advancing the stored clock. */
	peekNext(): string {
		return packHlc(sendHlc(this.hlc));
	}

	/** Current clock, packed. */
	packed(): string {
		return packHlc(this.hlc);
	}

	/**
	 * Advance past a remote HLC (an accepted client op, or a row written by
	 * another instance). Malformed input is ignored — callers reject it through
	 * their own clock-drift gate.
	 */
	receive(packedRemote: string): void {
		try {
			this.hlc = receiveHlc(this.hlc, unpackHlc(packedRemote));
			this.schedulePersist();
		} catch {
			// Malformed HLC — leave the clock alone.
		}
	}

	/** Flush any pending watermark write and stop the timer. */
	async close(): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		await this.flush();
	}

	private schedulePersist(): void {
		if (!this.storage) return;
		this.persistPending = true;
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.flush();
		}, HLC_PERSIST_INTERVAL_MS);
		if (typeof (this.persistTimer as unknown as { unref?: () => void }).unref === "function") {
			(this.persistTimer as unknown as { unref: () => void }).unref();
		}
	}

	private async flush(): Promise<void> {
		if (!this.storage || !this.persistPending) return;
		this.persistPending = false;
		// Merge the shared value first so the write can only move the watermark
		// forward. Without this, an instance whose clock trails its peers writes
		// a LOWER watermark than they already published and erodes the very
		// protection this exists to provide. (A peer more than
		// MAX_CLOCK_DRIFT_MS ahead is still not followed — that clamp is the
		// anti-runaway guard and outranks monotonicity.)
		await this.refresh();
		// Write a lease ahead of "now" so a crash inside the throttle window
		// still restarts above every HLC this instance handed out.
		const watermark = packHlc({
			ms: this.hlc.ms + HLC_PERSIST_LEASE_MS,
			counter: 0,
			nodeId: this.hlc.nodeId,
		});
		try {
			await this.storage.setMeta(SERVER_HLC_META_KEY, watermark);
		} catch (err) {
			console.error("[reflectdb] Failed to persist server HLC watermark:", err);
		}
	}
}
