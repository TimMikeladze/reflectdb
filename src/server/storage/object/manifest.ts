/**
 * Manifest CAS and writer election for the object-storage backend.
 *
 * The manifest is the single linearization point: one small object, overwritten
 * only through a conditional PUT. Everything else in the layout is write-once,
 * which is what makes concurrent readers safe.
 *
 * **The manifest CAS is the real safety guard, not lease expiry.** A zombie
 * writer — paused by a long GC, a stalled VM, a network partition — can still
 * believe it holds a valid lease. What it cannot have is a current manifest
 * etag: the moment a successor commits, the zombie's `ifMatch` fails with 412.
 * It can only write orphan WAL segments, which no manifest ever references and
 * no reader ever loads. The lease is an optimization that stops two servers
 * from doing redundant work; it is not what keeps the data correct. Designing
 * it the other way around is the classic distributed-lock hole.
 */

import { PreconditionFailedError, NotWriterError } from "./types.ts";
import type {
	ConcurrencyMode,
	LeaseConfig,
	LeaseRecord,
	ManifestRecord,
	ObjectDriver,
} from "./types.ts";
import { systemClock } from "./state.ts";
import type { Clock } from "./state.ts";

const MANIFEST_KEY = "_manifest";
const LEASE_KEY = "_lease";

/**
 * Room key namespace. The driver owns bucket and prefix; the room path is the
 * adapter's, because `roomId` is adapter configuration.
 *
 * `encodeURIComponent` is not cosmetic: a room id containing `/` or `..` would
 * otherwise write into another room's namespace, and room ids routinely come
 * from user-controlled URL segments via `resolveRoomKey`.
 */
export function roomPrefix(roomId: string): string {
	return `rooms/${encodeURIComponent(roomId)}/`;
}

export function emptyManifest(): ManifestRecord {
	return {
		version: 1,
		epoch: 0,
		commitSeq: 0,
		lastWriter: "",
		snapshotKey: null,
		snapshotHlc: null,
		walSegs: [],
		oplogHead: null,
		meta: {},
		pendingGc: [],
	};
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
	return encoder.encode(JSON.stringify(value));
}

export function decodeJson<T>(body: Uint8Array, key: string): T {
	try {
		return JSON.parse(decoder.decode(body)) as T;
	} catch (error) {
		// Never fall back to "treat it as a fresh room": that would hand a writer
		// an empty manifest for a room that already has state, and its first
		// commit would orphan every segment the room owns.
		throw new Error(
			`Object storage: "${key}" is not valid JSON and cannot be recovered automatically. ` +
				`Refusing to continue rather than overwrite live room state. (${String(error)})`,
		);
	}
}

export interface ManifestStoreOptions {
	driver: ObjectDriver;
	roomId: string;
	writerId: string;
	lease: Required<LeaseConfig>;
	concurrency?: ConcurrencyMode;
	clock?: Clock;
}

/**
 * Attempts a losing commit makes before giving up in `"optimistic"` mode.
 *
 * Each retry is one GET plus one PUT, and every attempt after the first is a
 * real contention signal rather than a transient error, so the ceiling is low.
 * Exhausting it means sustained write contention on one room — a routing
 * problem, not something more retries would fix.
 */
const OPTIMISTIC_MAX_ATTEMPTS = 6;

export class ManifestStore {
	private readonly driver: ObjectDriver;
	private readonly roomId: string;
	private readonly writerId: string;
	private readonly leaseConfig: Required<LeaseConfig>;
	private readonly concurrency: ConcurrencyMode;
	private readonly clock: Clock;
	private readonly manifestKey: string;
	private readonly leaseKey: string;

	private cached: ManifestRecord = emptyManifest();
	private cachedEtag: string | null = null;
	private loaded = false;

	private leaseEtag: string | null = null;
	private leaseEpoch = 0;
	private leaseExpiresAt = 0;
	private held = false;
	private cancelRenew: (() => void) | null = null;
	private wroteSinceRenew = false;
	private fenceReason: string | null = null;
	private stopped = false;

	/**
	 * Serializes every conditional write. Two concurrent commits — a WAL flush
	 * and a `setMeta`, say — would each read the same cached etag and the loser
	 * would take a 412, which this class is obliged to read as a lost fence. A
	 * self-inflicted fence would take the room down for no reason, so commits
	 * queue instead of racing.
	 */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(options: ManifestStoreOptions) {
		this.driver = options.driver;
		this.roomId = options.roomId;
		this.writerId = options.writerId;
		this.leaseConfig = options.lease;
		this.concurrency = options.concurrency ?? "single-writer";
		this.clock = options.clock ?? systemClock;
		const prefix = roomPrefix(options.roomId);
		this.manifestKey = `${prefix}${MANIFEST_KEY}`;
		this.leaseKey = `${prefix}${LEASE_KEY}`;
	}

	/** The cached manifest. Read-only: mutate it through `commit`. */
	get manifest(): ManifestRecord {
		return this.cached;
	}

	/** Fencing token stamped into every segment name and manifest write. */
	get epoch(): number {
		return this.leaseEpoch;
	}

	get isWriter(): boolean {
		return this.held && !this.fenceReason;
	}

	get fenced(): boolean {
		return this.fenceReason !== null;
	}

	// ── boot ──────────────────────────────────────────────────────────────

	/**
	 * One-time seed for stores without create-if-absent.
	 *
	 * MinIO shipped conditional writes before AWS did, but never accepted the `*`
	 * wildcard — it requires an exact etag — so `_lease` and `_manifest` cannot
	 * be created conditionally there. They are seeded with an UNCONDITIONAL PUT
	 * instead, and an unconditional PUT is exactly what the rest of this design
	 * exists to avoid.
	 *
	 * **This is a deploy step, not something N racing servers run.** Two servers
	 * seeding the same room concurrently can both observe an absent manifest and
	 * both write one; the second silently discards the first's state. It is safe
	 * here only because this design routes one writer per room, so exactly one
	 * process ever boots a given room — that routing is load-bearing, not an
	 * optimization. On a wildcard-capable driver this is a no-op and the first
	 * real write creates both objects under `ifNoneMatch: "*"`.
	 */
	async init(): Promise<void> {
		if (this.driver.caps.casWildcard) return;
		if (!(await this.driver.get(this.manifestKey))) {
			await this.driver.put(this.manifestKey, encodeJson(emptyManifest()));
		}
		if (!(await this.driver.get(this.leaseKey))) {
			const unowned: LeaseRecord = { owner: "", epoch: 0, expiresAt: 0 };
			await this.driver.put(this.leaseKey, encodeJson(unowned));
		}
	}

	/**
	 * Reads the manifest and caches its etag. An absent manifest means a fresh
	 * room, so an empty one is synthesized with a `null` etag — the first commit
	 * then creates it with `ifNoneMatch: "*"` and loses cleanly to any writer
	 * that got there first.
	 */
	async load(): Promise<ManifestRecord> {
		const record = await this.driver.get(this.manifestKey);
		if (!record) {
			this.cached = emptyManifest();
			this.cachedEtag = null;
		} else {
			this.cached = decodeJson<ManifestRecord>(record.body, this.manifestKey);
			this.cachedEtag = record.etag;
			// A manifest written before `commitSeq` existed decodes without it, and
			// `undefined + 1` is NaN — which `JSON.stringify` writes as `null`, so
			// two consecutive commits would serialize identically and hand back the
			// exact lost update the counter exists to make impossible. Normalize on
			// the way in rather than trusting the decoded shape.
			if (typeof this.cached.commitSeq !== "number") this.cached.commitSeq = 0;
			// Absent in a manifest written before `lastWriter` existed. Empty string
			// matches no real writerId, so adoption correctly declines rather than
			// guessing.
			if (typeof this.cached.lastWriter !== "string") this.cached.lastWriter = "";
			// Boot inherits the committed epoch so a lease acquired later can only
			// move it forward, even if `_lease` was lost or reset.
			if (this.cached.epoch > this.leaseEpoch) this.leaseEpoch = this.cached.epoch;
		}
		this.loaded = true;
		return this.cached;
	}

	// ── lease ─────────────────────────────────────────────────────────────

	/**
	 * Acquires the lease up front under `lease.mode: "always"`. Under
	 * `"on-write"` this is a no-op and the lease is taken by the first commit,
	 * so a room holding connected clients but taking no writes issues zero PUTs
	 * and arms zero timers.
	 */
	async start(): Promise<void> {
		// No lease at all in `"optimistic"`: there is no single writer to elect, and
		// arming a renew timer would burn a PUT every `renewMs` per instance for a
		// token nothing reads.
		if (this.concurrency === "optimistic") return;
		if (this.leaseConfig.mode === "always") await this.acquire();
	}

	/**
	 * Takes writer ownership, bumping the fencing epoch.
	 *
	 * @throws {NotWriterError} when another writer holds an unexpired lease, or
	 * when the CAS is lost to a concurrent acquire.
	 */
	async acquire(): Promise<void> {
		this.assertNotFenced();
		const current = await this.driver.get(this.leaseKey);
		const record = current ? decodeJson<LeaseRecord>(current.body, this.leaseKey) : null;
		const now = this.clock.now();

		if (record && record.owner !== this.writerId && record.expiresAt > now) {
			throw new NotWriterError(
				this.roomId,
				`lease held by "${record.owner}" for another ${record.expiresAt - now}ms`,
			);
		}

		// Re-taking a lease we still own keeps the epoch: nothing was fenced, and
		// a needless bump would reset the WAL sequence for no reason. Taking one
		// from an expired owner bumps it, which is what invalidates their segments.
		//
		// `this.leaseEtag !== null` is what makes "we still own it" mean THIS
		// INSTANCE, not merely this `writerId`. Matching on the stored owner alone
		// is a data-loss bug, and `writerId` is exactly the kind of value people
		// set to a stable pod or machine name (see `ObjectStorageConfig.writerId`):
		//
		//   1. Process A ("web-1") takes epoch 1 and flushes `wal/1-0.jsonl`; the
		//      manifest references it and the client's op is acked and retired.
		//   2. A is SIGKILLed. No `close()`, so the lease is never released and
		//      `expiresAt` is still in the future.
		//   3. A' starts with the same `writerId`, finds that unexpired lease, and
		//      on an owner-only check keeps epoch 1. `WalWriter.seqEpoch` starts at
		//      -1, so its sequence restarts at 0.
		//   4. A's first flush PUTs `wal/1-0.jsonl` — unconditionally, because the
		//      key is supposed to be unique — over the live segment. The
		//      acknowledged write in it is gone, `walSegs` now lists the same key
		//      twice, and nothing reports an error. A' still serves the lost row
		//      from memory, so it stays invisible until the NEXT restart.
		//
		// A cold start therefore always bumps the epoch, which is precisely what
		// `release()` reasons about: a fresh epoch is what makes segment names
		// unique across process lifetimes.
		const ours = record?.owner === this.writerId && record.expiresAt > now && this.leaseEtag !== null;
		const epoch = ours ? record.epoch : Math.max(record?.epoch ?? 0, this.leaseEpoch) + 1;
		const next: LeaseRecord = { owner: this.writerId, epoch, expiresAt: now + this.leaseConfig.ttlMs };

		try {
			this.leaseEtag = await this.driver.put(
				this.leaseKey,
				encodeJson(next),
				current ? { ifMatch: current.etag } : this.createOptions(),
			);
		} catch (error) {
			if (error instanceof PreconditionFailedError) {
				throw new NotWriterError(this.roomId, "lost the lease CAS to a concurrent writer");
			}
			throw error;
		}

		this.leaseEpoch = epoch;
		this.leaseExpiresAt = next.expiresAt;
		this.held = true;
		this.armRenew();
	}

	/**
	 * Acquires the lease if this writer does not already hold it. Called on the
	 * write path so `lease.mode: "on-write"` stays lazy, and after an idle lapse.
	 */
	async ensureWriter(): Promise<void> {
		// In `"optimistic"` there is nothing to become: every writer is equal and
		// the manifest CAS decides each commit on its own.
		if (this.concurrency === "optimistic") return;
		this.assertNotFenced();
		if (this.held) return;
		await this.acquire();
	}

	/**
	 * Releases the lease on a clean shutdown, so failover is immediate instead of
	 * waiting out `ttlMs`.
	 *
	 * The lease object is overwritten with an unowned record rather than deleted.
	 * A delete would let the next writer start again at epoch 1, and the epoch is
	 * in every WAL segment name — a reused `<epoch>-<seq>` could collide with an
	 * orphan segment left behind by the previous generation and silently change
	 * its contents.
	 */
	async release(): Promise<void> {
		this.disarmRenew();
		if (!this.held || !this.leaseEtag) return;
		this.held = false;
		const unowned: LeaseRecord = { owner: "", epoch: this.leaseEpoch, expiresAt: 0 };
		try {
			await this.driver.put(this.leaseKey, encodeJson(unowned), { ifMatch: this.leaseEtag });
		} catch (error) {
			// A lost release is not worth failing a shutdown over: the lease simply
			// expires on its own, which is the same outcome as an unclean stop.
			if (!(error instanceof PreconditionFailedError)) throw error;
		}
		this.leaseEtag = null;
	}

	stop(): void {
		this.stopped = true;
		this.disarmRenew();
	}

	// ── commit ────────────────────────────────────────────────────────────

	/**
	 * Applies `mutate` to a copy of the manifest and commits it with a
	 * conditional PUT. Returns the committed record.
	 *
	 * A `PreconditionFailedError` here is NOT retried. A manifest CAS failure
	 * means this writer's fence is gone — another process committed against the
	 * etag we were holding — so re-reading and re-applying would layer our
	 * changes on top of state we no longer own, which is how two writers turn a
	 * partition into corruption. The writer fences itself and every later call
	 * throws `NotWriterError` immediately.
	 */
	commit(mutate: (manifest: ManifestRecord) => void): Promise<ManifestRecord> {
		const apply =
			this.concurrency === "optimistic"
				? () => this.doCommitOptimistic(mutate)
				: () => this.doCommit(mutate);
		const run = this.chain.then(apply, apply);
		// The chain must never stay rejected, or one failed commit would reject
		// every commit queued behind it without ever attempting them.
		this.chain = run.catch(() => undefined);
		return run;
	}

	/**
	 * `"optimistic"` commit: lose the CAS, re-read, re-apply, try again.
	 *
	 * Every writer is equal here, so a 412 is ordinary contention rather than a
	 * fence — someone else committed between our read and our write, and the
	 * correct response is to rebuild the change on top of theirs. `mutate` is
	 * re-run against the freshly loaded manifest rather than replayed onto a
	 * stale copy, which is what makes the result a merge instead of an
	 * overwrite: a WAL append pushes onto their `walSegs`, a compaction recomputes
	 * against their state.
	 *
	 * This is the same guarantee the single-writer mode relies on. The class
	 * header says it outright — the manifest CAS is what keeps the data correct
	 * and the lease is only an optimization — so removing the lease costs
	 * throughput under contention, never correctness.
	 */
	private async doCommitOptimistic(
		mutate: (manifest: ManifestRecord) => void,
	): Promise<ManifestRecord> {
		for (let attempt = 1; ; attempt++) {
			if (!this.loaded) await this.load();

			const next = this.buildNext();
			mutate(next);

			try {
				const etag = await this.driver.put(
					this.manifestKey,
					encodeJson(next),
					this.cachedEtag ? { ifMatch: this.cachedEtag } : this.createOptions(),
				);
				this.cached = next;
				this.cachedEtag = etag;
				return next;
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) throw error;
				// Our own commit, acknowledged late — see `adoptOwnCommit`.
				if (await this.adoptOwnCommit(next)) return next;
				if (attempt >= OPTIMISTIC_MAX_ATTEMPTS) {
					throw new Error(
						`Object storage: room "${this.roomId}" lost the manifest CAS ` +
							`${OPTIMISTIC_MAX_ATTEMPTS} times in a row. That is sustained write ` +
							`contention on one room, which more retries will not fix — route the ` +
							`room to fewer writers, or use concurrency: "single-writer".`,
					);
				}
				// Re-read so the next attempt builds on the winner's manifest.
				await this.load();
			}
		}
	}

	/** The next manifest, derived from the cached one. Shared by both commit paths. */
	private buildNext(): ManifestRecord {
		return {
			...this.cached,
			epoch: this.concurrency === "optimistic" ? this.cached.epoch : this.leaseEpoch,
			commitSeq: this.cached.commitSeq + 1,
			lastWriter: this.writerId,
			walSegs: [...this.cached.walSegs],
			meta: { ...this.cached.meta },
			pendingGc: [...this.cached.pendingGc],
		};
	}

	/**
	 * Re-reads the manifest and folds in anything another writer committed.
	 *
	 * Only meaningful in `"optimistic"`, where in-memory state is NOT
	 * authoritative: another instance may have committed since this one last
	 * looked, so a read that must be current has to check. Costs one GET, and
	 * returns `false` without doing anything more when `commitSeq` has not moved
	 * — which is the common case and what makes a poll loop cheap.
	 *
	 * Returns the freshly loaded manifest. Deliberately does NOT report whether
	 * anything "changed": the commit path also reloads on a lost CAS, so
	 * `commitSeq` can advance without this instance having applied the segments
	 * that came with it. Only the caller, which tracks what it has applied, can
	 * answer that.
	 */
	async refresh(): Promise<ManifestRecord> {
		const record = await this.driver.get(this.manifestKey);
		if (!record) return this.cached;
		const stored = decodeJson<ManifestRecord>(record.body, this.manifestKey);
		if (typeof stored.commitSeq !== "number") stored.commitSeq = 0;
		if (typeof stored.lastWriter !== "string") stored.lastWriter = "";
		this.cached = stored;
		this.cachedEtag = record.etag;
		this.loaded = true;
		return stored;
	}

	private async doCommit(mutate: (manifest: ManifestRecord) => void): Promise<ManifestRecord> {
		this.assertNotFenced();
		if (this.stopped) {
			// A flush that a bounded shutdown abandoned can land here long after
			// `close()` returned. Refusing keeps it from re-acquiring the lease the
			// room just released and writing into a store the process has finished
			// with — a resurrected writer that no supervisor is watching.
			throw new Error(
				`Object storage: room "${this.roomId}" is closed; refusing to commit its manifest.`,
			);
		}
		if (!this.loaded) await this.load();
		// Lazy acquisition: under "on-write" the lease is taken here, on the first
		// write, and re-taken after an idle lapse.
		if (!this.held) await this.acquire();

		const next = this.buildNext();
		mutate(next);

		let etag: string;
		try {
			etag = await this.driver.put(
				this.manifestKey,
				encodeJson(next),
				this.cachedEtag ? { ifMatch: this.cachedEtag } : this.createOptions(),
			);
		} catch (error) {
			if (error instanceof PreconditionFailedError) {
				// A 412 is NOT automatically someone else's commit. A manifest PUT the
				// store applied and whose RESPONSE was lost — timeout, connection
				// reset, a 500 raised after the write landed — leaves `cachedEtag`
				// pointing at the previous version, so the retry's `ifMatch` fails
				// against OUR OWN write. Lost responses are routine on S3, and fencing
				// on one would let a single dropped packet permanently brick a healthy
				// room: `fenceReason` is never cleared, so every later call throws,
				// including `close()`'s final drain.
				//
				// So read the manifest back before deciding. If it carries our epoch
				// and the `commitSeq` we just tried to write, the commit succeeded and
				// only the acknowledgement was lost — adopt the etag and carry on.
				const adopted = await this.adoptOwnCommit(next);
				if (adopted) return next;

				this.fence("the manifest CAS was lost — another writer owns this room");
				throw new NotWriterError(
					this.roomId,
					"manifest CAS failed; another writer committed against this etag",
				);
			}
			throw error;
		}

		this.cached = next;
		this.cachedEtag = etag;
		this.wroteSinceRenew = true;
		return next;
	}

	// ── internals ─────────────────────────────────────────────────────────

	/**
	 * Options for creating an object that should not already exist. Without
	 * wildcard CAS there is no way to express that, so `init()` must have seeded
	 * the key already — reaching here means it did not.
	 */
	private createOptions(): { ifNoneMatch: "*" } | undefined {
		if (this.driver.caps.casWildcard) return { ifNoneMatch: "*" };
		throw new Error(
			`Object storage: this driver does not support create-if-absent ` +
				`(caps.casWildcard === false, e.g. MinIO), and room "${this.roomId}" has not ` +
				`been seeded. Run the adapter's init() once as a deploy step before starting ` +
				`writers. See docs/object-storage.md#the-minio-gotcha.`,
		);
	}

	/**
	 * Distinguishes "our own commit whose response was lost" from "another writer
	 * got there first", after a 412.
	 *
	 * Reads the manifest back and compares it against what we tried to write.
	 * `commitSeq` is what makes this decidable: it advances on every commit, so a
	 * stored manifest carrying OUR epoch and EXACTLY the `commitSeq` we attempted
	 * can only be the write we just issued. A successor's commit necessarily
	 * carries a higher epoch (its lease bumped it) or a different `commitSeq`.
	 *
	 * Conservative on purpose — anything that does not match exactly falls
	 * through to fencing, because wrongly adopting a successor's manifest would
	 * be far worse than a false fence.
	 *
	 * Returns true when the commit was ours and the cache has been repaired.
	 */
	private async adoptOwnCommit(attempted: ManifestRecord): Promise<boolean> {
		let current: Awaited<ReturnType<ObjectDriver["get"]>>;
		try {
			current = await this.driver.get(this.manifestKey);
		} catch {
			// The read-back itself failed, so we cannot tell the cases apart. Fence:
			// treating an unknown state as "still the writer" risks two live writers.
			return false;
		}
		if (!current) return false;

		let stored: ManifestRecord;
		try {
			stored = decodeJson<ManifestRecord>(current.body, this.manifestKey);
		} catch {
			return false;
		}

		// `lastWriter` is the load-bearing half. Under `"optimistic"` every instance
		// shares the manifest's epoch and races for the same `commitSeq`, so an
		// epoch/commitSeq match would be satisfied by a RIVAL's commit — and
		// adopting it would report success for a segment the manifest never
		// references, losing every record in it with no error raised.
		if (
			stored.lastWriter !== this.writerId ||
			stored.commitSeq !== attempted.commitSeq ||
			stored.epoch !== attempted.epoch
		) {
			return false;
		}

		this.cached = stored;
		this.cachedEtag = current.etag;
		this.wroteSinceRenew = true;
		return true;
	}

	private assertNotFenced(): void {
		if (this.fenceReason) throw new NotWriterError(this.roomId, this.fenceReason);
	}

	private fence(reason: string): void {
		if (this.fenceReason) return;
		this.fenceReason = reason;
		this.held = false;
		this.disarmRenew();
	}

	private armRenew(): void {
		this.disarmRenew();
		if (this.stopped) return;
		this.wroteSinceRenew = false;
		this.cancelRenew = this.clock.setTimer(() => {
			void this.onRenewTick();
		}, this.leaseConfig.renewMs);
	}

	private disarmRenew(): void {
		this.cancelRenew?.();
		this.cancelRenew = null;
	}

	private async onRenewTick(): Promise<void> {
		this.cancelRenew = null;
		if (this.stopped || !this.held || this.fenceReason) return;

		// Under "on-write", a room that has taken no writes since the last tick
		// stops renewing and lets the lease lapse. That is the whole reason idle
		// rooms are free: no timer, no PUT, no cost. The next write re-acquires,
		// and if someone else took the room in the meantime the manifest CAS
		// catches it — the lease was never the guard.
		if (this.leaseConfig.mode === "on-write" && !this.wroteSinceRenew) {
			this.held = false;
			return;
		}

		try {
			await this.renew();
			this.armRenew();
		} catch (error) {
			if (error instanceof PreconditionFailedError || error instanceof NotWriterError) {
				this.fence("lease renewal lost the CAS — another writer took this room");
				return;
			}
			// A transient store error is not a lost lease. Fencing on the first
			// network blip would take down a healthy writer that still has minutes
			// of TTL left; fencing only once the TTL has actually elapsed is the
			// honest condition, because that is the moment ownership stops being
			// provable. Until then, retry sooner than the normal cadence.
			if (this.clock.now() >= this.leaseExpiresAt) {
				this.fence("lease expired while renewals were failing");
				return;
			}
			this.cancelRenew = this.clock.setTimer(() => {
				void this.onRenewTick();
			}, Math.max(1, Math.floor(this.leaseConfig.renewMs / 4)));
		}
	}

	private async renew(): Promise<void> {
		const now = this.clock.now();
		const next: LeaseRecord = {
			owner: this.writerId,
			epoch: this.leaseEpoch,
			expiresAt: now + this.leaseConfig.ttlMs,
		};
		const etag = await this.driver.put(
			this.leaseKey,
			encodeJson(next),
			this.leaseEtag ? { ifMatch: this.leaseEtag } : this.createOptions(),
		);
		this.leaseEtag = etag;
		this.leaseExpiresAt = next.expiresAt;
		this.wroteSinceRenew = false;
	}
}
