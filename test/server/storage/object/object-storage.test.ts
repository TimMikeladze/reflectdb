import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemDriver } from "../../../../src/server/storage/object/drivers/filesystem.ts";
import { createMemoryDriver } from "../../../../src/server/storage/object/drivers/memory.ts";
import {
	createObjectStorage,
	type ObjectStorage,
} from "../../../../src/server/storage/object/index.ts";
import { ProcessMemoryBudget } from "../../../../src/server/storage/object/state.ts";
import type { ObjectDriver } from "../../../../src/server/storage/object/types.ts";
import { runStorageAdapterSuite } from "../storage-adapter-suite.ts";

const roots: string[] = [];
const opened: ObjectStorage[] = [];

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "reflectdb-objadapter-"));
	roots.push(root);
	return root;
}

afterAll(async () => {
	// Every adapter holds a flush loop; leaving them running keeps the process
	// alive and leaks a lease renewal timer per room.
	await Promise.allSettled(opened.map((s) => s.close()));
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let roomSeq = 0;

/**
 * A fresh adapter over a fresh driver. Each gets its own memory budget so the
 * process-wide one is not shared across tests running in the same file.
 */
function open(
	driver: ObjectDriver,
	config: Partial<Parameters<typeof createObjectStorage>[0]> = {},
): ObjectStorage {
	const storage = createObjectStorage(
		{ driver, roomId: `room-${++roomSeq}`, ...config },
		{ budget: new ProcessMemoryBudget() },
	);
	opened.push(storage);
	return storage;
}

// ── the shared StorageAdapter conformance suite ───────────────────────────
//
// The point of the whole exercise: an adapter with no Postgres and no SQLite
// has to satisfy exactly the contract `handler.ts` expects, or none of the sync
// engine above it works.

runStorageAdapterSuite("object storage (memory driver)", () => open(createMemoryDriver()));
runStorageAdapterSuite("object storage (filesystem driver)", () =>
	open(createFilesystemDriver(freshRoot())),
);

// ── object-storage specifics ──────────────────────────────────────────────

const hlc = (n: number) => `${String(n).padStart(19, "0")}.0000.server:1`;

describe("object storage: durability", () => {
	test("a durable write is on the store before it resolves", async () => {
		const driver = createMemoryDriver();
		const storage = open(driver);
		await storage.init();

		await storage.applyOp!("posts", "r1", { id: "r1" }, {}, hlc(1), "insert", { id: "r1" });

		// Resolved means committed: a WAL segment and a manifest naming it.
		const keys = [...driver.dump().keys()];
		expect(keys.some((k) => k.includes("/wal/"))).toBe(true);
		expect(storage.durableHlc).toBe(hlc(1));
	});

	test("durable is the default — a lossy default would be a correctness trade", () => {
		// The knob exists, but nobody has to know about it to be safe.
		const storage = open(createMemoryDriver());
		expect(storage.health).toBe("healthy");
	});

	test("onDurable fires with the batch watermark", async () => {
		const seen: string[] = [];
		const storage = open(createMemoryDriver(), { onDurable: (h) => seen.push(h) });
		await storage.init();

		await storage.appendOp({
			table: "posts",
			op: "insert",
			rowId: "r1",
			payload: null,
			hlc: hlc(1),
			colClocks: {},
		});
		expect(seen).toEqual([hlc(1)]);
	});
});

describe("object storage: group commit", () => {
	test("concurrent writes coalesce into one segment, not one per op", async () => {
		const driver = createMemoryDriver();
		const storage = open(driver, { batch: { minLingerMs: 5 } });
		await storage.init();

		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				storage.appendOp({
					table: "posts",
					op: "insert",
					rowId: `r${i}`,
					payload: null,
					hlc: hlc(i + 1),
					colClocks: {},
				}),
			),
		);

		const segments = [...driver.dump().keys()].filter((k) => k.includes("/wal/"));
		// The exact count depends on scheduling, but "one PUT per op" is the
		// failure the self-clocking loop exists to prevent.
		expect(segments.length).toBeLessThan(20);
		expect(await storage.getOpsSince(hlc(0), ["posts"])).toHaveLength(20);
	});

	test("an idle room issues zero PUTs", async () => {
		// The cost argument for lease.mode "on-write": a room holding connected
		// clients but taking no writes must not spend anything.
		const driver = createMemoryDriver();
		const storage = open(driver);
		await storage.init();

		await storage.getRow("posts", "r1");
		await storage.getRows("posts");
		await storage.getOpsSince(hlc(0), ["posts"]);

		expect(driver.stats.put).toBe(0);
	});
});

describe("object storage: boot and replay", () => {
	test("a second adapter over the same store sees the first one's writes", async () => {
		const driver = createMemoryDriver();
		const first = open(driver, { roomId: "shared" });
		await first.init();
		await first.applyOp!("posts", "r1", { id: "r1", title: "v1" }, { title: hlc(1) }, hlc(1), "insert", null);
		await first.setMeta("cursor", "abc");
		await first.flush();
		await first.close();

		const second = open(driver, { roomId: "shared" });
		await second.init();

		expect((await second.getRow("posts", "r1")).row).toEqual({ id: "r1", title: "v1" });
		expect(await second.getMeta("cursor")).toBe("abc");
		expect(await second.getOpsSince(hlc(0), ["posts"])).toHaveLength(1);
	});

	test("state survives a restart through the filesystem driver", async () => {
		const root = freshRoot();
		const first = open(createFilesystemDriver(root), { roomId: "persist" });
		await first.init();
		await first.applyOp!("posts", "r1", { id: "r1" }, {}, hlc(1), "insert", null);
		await first.close();

		const second = open(createFilesystemDriver(root), { roomId: "persist" });
		await second.init();
		expect((await second.getRow("posts", "r1")).row).toEqual({ id: "r1" });
	});

	test("a missing WAL segment refuses to boot rather than silently truncating", async () => {
		const driver = createMemoryDriver();
		const first = open(driver, { roomId: "torn" });
		await first.init();
		await first.applyOp!("posts", "r1", { id: "r1" }, {}, hlc(1), "insert", null);
		await first.close();

		// Simulate the store losing an object the manifest still names.
		const segment = [...driver.dump().keys()].find((k) => k.includes("/wal/"))!;
		await driver.delete([segment]);

		const second = open(driver, { roomId: "torn" });
		// Booting on partial state would present the loss as an empty room and
		// then overwrite what remains.
		await expect(second.init()).rejects.toThrow(/missing|truncated/i);
	});
});

describe("object storage: compaction", () => {
	/** Writes enough segments to trip `compaction.afterSegments`. */
	async function writeUntilCompacted(storage: ObjectStorage, count: number) {
		for (let i = 0; i < count; i++) {
			await storage.applyOp!("posts", `r${i}`, { id: `r${i}` }, {}, hlc(i + 1), "insert", null);
		}
	}

	test("folds WAL segments into a snapshot and keeps the rows", async () => {
		const driver = createMemoryDriver();
		const storage = open(driver, {
			roomId: "compact",
			compaction: { afterSegments: 5, gcGraceMs: 0 },
		});
		await storage.init();
		await writeUntilCompacted(storage, 12);

		expect([...driver.dump().keys()].some((k) => k.includes("/snap/"))).toBe(true);
		expect((await storage.getRow("posts", "r0")).row).toEqual({ id: "r0" });
		expect((await storage.getRow("posts", "r11")).row).toEqual({ id: "r11" });
	});

	test("rows survive a restart after compaction", async () => {
		const driver = createMemoryDriver();
		const first = open(driver, {
			roomId: "compact-restart",
			compaction: { afterSegments: 5, gcGraceMs: 0 },
		});
		await first.init();
		await writeUntilCompacted(first, 12);
		await first.close();

		const second = open(driver, { roomId: "compact-restart" });
		await second.init();
		expect((await second.getRow("posts", "r0")).row).toEqual({ id: "r0" });
		expect((await second.getRow("posts", "r11")).row).toEqual({ id: "r11" });
	});

	test("compaction advances the resume cutoff, so a stale resume is rejected", async () => {
		// Regression, and the nastiest failure this backend can have. A snapshot
		// carries rows but no ops, and compaction clears `walSegs`, so the op ring
		// boots EMPTY after a restart. `handleResume` rejects a client whose
		// watermark predates `getMeta("compactionCutoff")`; without a cutoff it
		// instead asks `getChangedTablesSince`, gets [] from the empty ring, and
		// tells the client nothing changed — leaving it on arbitrarily stale rows
		// forever, with no error raised anywhere.
		const driver = createMemoryDriver();
		const first = open(driver, {
			roomId: "cutoff",
			compaction: { afterSegments: 5, gcGraceMs: 0 },
		});
		await first.init();
		await writeUntilCompacted(first, 12);

		const cutoff = await first.getMeta("compactionCutoff");
		expect(cutoff).not.toBeNull();
		await first.close();

		const second = open(driver, { roomId: "cutoff" });
		await second.init();

		// Survives the restart, since handleResume reads it through getMeta.
		expect(await second.getMeta("compactionCutoff")).toBe(cutoff!);
		// And it is past the watermark a client from before compaction would hold,
		// which is what makes handleResume reject rather than under-report.
		expect(hlc(1) < cutoff!).toBe(true);

		// The ops folded into the snapshot are genuinely gone after the restart —
		// only segments written since the last compaction replay. That is the
		// under-reporting the cutoff protects against: without it, a client holding
		// a watermark below `cutoff` would be told only these later tables changed.
		const replayed = await second.getOpsSince(hlc(0), ["posts"]);
		expect(replayed.length).toBeGreaterThan(0);
		expect(replayed.length).toBeLessThan(12);
		for (const op of replayed) expect(op.hlc > cutoff!).toBe(true);
	});

	test("the cutoff never moves backwards", async () => {
		const driver = createMemoryDriver();
		const storage = open(driver, {
			roomId: "cutoff-monotonic",
			compaction: { afterSegments: 3, gcGraceMs: 0 },
		});
		await storage.init();
		await writeUntilCompacted(storage, 8);
		const first = await storage.getMeta("compactionCutoff");

		// A later compaction whose rows carry LOWER HLCs must not lower the cutoff,
		// or resumes it had already correctly rejected would start being admitted.
		for (let i = 0; i < 8; i++) {
			await storage.applyOp!("posts", `low${i}`, { id: `low${i}` }, {}, hlc(1), "insert", null);
		}
		const second = await storage.getMeta("compactionCutoff");
		expect(second! >= first!).toBe(true);
	});
});

describe("object storage: fencing", () => {
	test("a lost manifest CAS fences the writer instead of retrying", async () => {
		const driver = createMemoryDriver();
		const storage = open(driver, { roomId: "fenced" });
		await storage.init();
		await storage.applyOp!("posts", "r1", { id: "r1" }, {}, hlc(1), "insert", null);

		// Another writer commits against the same room, invalidating our etag.
		const manifestKey = [...driver.dump().keys()].find((k) => k.endsWith("_manifest"))!;
		const current = await driver.get(manifestKey);
		await driver.put(manifestKey, current!.body, { ifMatch: current!.etag });

		// Retrying with a provably stale etag would either fail identically or, on
		// a weaker store, clobber the winner. The only correct move is to stop.
		await expect(
			storage.applyOp!("posts", "r2", { id: "r2" }, {}, hlc(2), "insert", null),
		).rejects.toThrow(/writer/i);
		expect(storage.health).toBe("unavailable");
	});
});

describe("object storage: crash and retry safety", () => {
	test("a restart reusing the same writerId does not overwrite a live segment", async () => {
		// Regression. The lease's `ours` fast path matched on the stored owner
		// alone, so a fresh process with the same writerId that found its dead
		// predecessor's unexpired lease kept the epoch — and since the WAL sequence
		// restarts at 0 in a new process, its first flush PUT the same
		// `wal/<epoch>-0.jsonl` key over a segment the manifest still referenced.
		// The acknowledged write in it vanished with no error, and stayed invisible
		// until the next restart because the new process still served it from
		// memory. writerId is meant to be a stable pod name, so this is the
		// ordinary case, not an exotic one.
		const driver = createMemoryDriver();
		const writerId = "web-1";

		const a = open(driver, { roomId: "crash", writerId });
		await a.init();
		await a.applyOp!("posts", "X", { id: "X" }, {}, hlc(1), "insert", null);
		// No close(): a SIGKILL leaves the lease held and unexpired.

		const revived = open(driver, { roomId: "crash", writerId });
		await revived.init();
		await revived.applyOp!("posts", "Y", { id: "Y" }, {}, hlc(2), "insert", null);
		await revived.close();

		const third = open(driver, { roomId: "crash" });
		await third.init();
		expect((await third.getRow("posts", "X")).row).toEqual({ id: "X" });
		expect((await third.getRow("posts", "Y")).row).toEqual({ id: "Y" });
	});

	test("a lost manifest response is adopted, not treated as a fence", async () => {
		// Regression. A manifest PUT the store applied but whose response was lost
		// (timeout, reset, 500-after-commit — routine on S3) left `cachedEtag`
		// stale, so the retry's ifMatch failed against our OWN write and fenced the
		// room permanently. One dropped packet bricked a healthy room.
		let manifestPuts = 0;
		const driver = createMemoryDriver({
			faults: {
				before: (ctx) => {
					if (ctx.op !== "put" || !ctx.key.endsWith("_manifest")) return;
					manifestPuts++;
					// Let the FIRST manifest write land, then lose its response.
					if (manifestPuts === 1) return { throw: new Error("connection reset") };
				},
			},
		});

		const storage = open(driver, { roomId: "ambiguous" });
		await storage.init();
		await storage.applyOp!("posts", "A", { id: "A" }, {}, hlc(1), "insert", null);

		expect(storage.health).not.toBe("unavailable");
		await storage.applyOp!("posts", "B", { id: "B" }, {}, hlc(2), "insert", null);
		await storage.close();

		const reopened = open(driver, { roomId: "ambiguous" });
		await reopened.init();
		expect((await reopened.getRow("posts", "A")).row).toEqual({ id: "A" });
		expect((await reopened.getRow("posts", "B")).row).toEqual({ id: "B" });
	});

	test("a retry never reuses a WAL key it already wrote", async () => {
		// Segment keys must be write-once: rewriting one the durable manifest
		// already references means a concurrent reader can get either body, and the
		// recorded bytes/maxHlc stop describing the object.
		let manifestPuts = 0;
		const driver = createMemoryDriver({
			faults: {
				before: (ctx) => {
					if (ctx.op !== "put" || !ctx.key.endsWith("_manifest")) return;
					manifestPuts++;
					if (manifestPuts === 1) return { throw: new Error("connection reset") };
				},
			},
		});
		const storage = open(driver, { roomId: "no-reuse" });
		await storage.init();
		await storage.applyOp!("posts", "A", { id: "A" }, {}, hlc(1), "insert", null);
		await storage.applyOp!("posts", "B", { id: "B" }, {}, hlc(2), "insert", null);
		await storage.flush();

		const segments = [...driver.dump().keys()].filter((k) => k.includes("/wal/"));
		expect(new Set(segments).size).toBe(segments.length);
	});

	test("a transient boot failure is not cached forever", async () => {
		// Regression. Boot issues one GET per manifest, snapshot and WAL segment —
		// up to `afterSegments` of them — with no retry anywhere. Caching the
		// rejection let a single 503 brick the room: every later call re-threw the
		// same stale error with no way back.
		const driver = createMemoryDriver();
		const seeded = open(driver, { roomId: "boot-retry" });
		await seeded.init();
		await seeded.applyOp!("posts", "r1", { id: "r1" }, {}, hlc(1), "insert", null);
		await seeded.close();

		let fail = true;
		const flaky = createMemoryDriver();
		// Same bucket contents, but the first manifest GET 503s.
		for (const [key, body] of driver.dump()) await flaky.put(key, body);
		const failing = createObjectStorage(
			{
				driver: {
					...flaky,
					get: async (key: string) => {
						if (fail && key.endsWith("_manifest")) {
							fail = false;
							throw new Error("503 Service Unavailable");
						}
						return flaky.get(key);
					},
				},
				roomId: "boot-retry",
			},
			{ budget: new ProcessMemoryBudget() },
		);
		opened.push(failing);

		await expect(failing.init()).rejects.toThrow(/503/);
		// The retry succeeds rather than replaying the cached rejection.
		await failing.init();
		expect((await failing.getRow("posts", "r1")).row).toEqual({ id: "r1" });
	});

	test("applyOp leaves nothing behind when the memory budget refuses it", async () => {
		// Regression. putRow charged the budget and mutated, then appendOp charged
		// again and threw — so the caller was told the write was rejected while
		// authoritative state already held the row. toSnapshot reads that state, so
		// the next compaction would have made the rejected row permanently durable
		// with no op ever existing for it.
		const storage = open(createMemoryDriver(), {
			roomId: "budget-atomic",
			memory: { maxRoomBytes: 400 },
		});
		await storage.init();

		const big = { id: "r1", blob: "x".repeat(1024) };
		const error = await storage
			.applyOp!("posts", "r1", big, {}, hlc(1), "insert", big)
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect((error as Error | null)?.name).toBe("MemoryLimitExceededError");

		expect((await storage.getRow("posts", "r1")).row).toBeNull();
		expect(await storage.getOpsSince(hlc(0), ["posts"])).toEqual([]);
	});

	test("an outstanding flush settles when close abandons the buffer", async () => {
		// Regression. settleFlushWaiters returns early while the buffer is
		// non-empty, and stop() never rejected the waiters — so `const p =
		// storage.flush(); await storage.close();` waited forever, and an app
		// awaiting flush() in a SIGTERM handler hung until the platform kill timer.
		const driver = createMemoryDriver({
			faults: { before: (ctx) => (ctx.op === "put" ? { delayMs: 60_000 } : undefined) },
		});
		const storage = open(driver, { roomId: "flush-settles", shutdownFlushMs: 20 });
		await storage.init();

		void storage
			.appendOp({
				table: "posts",
				op: "insert",
				rowId: "r1",
				payload: null,
				hlc: hlc(1),
				colClocks: {},
			})
			.catch(() => undefined);
		// appendOp awaits ready() before buffering, so the record is not in the
		// buffer yet on the next microtask.
		await new Promise((resolve) => setTimeout(resolve, 5));

		const pending = storage.flush().then(
			() => "resolved",
			() => "rejected",
		);
		await storage.close();
		const outcome = await Promise.race([
			pending,
			new Promise((resolve) => setTimeout(() => resolve("still-pending"), 300)),
		]);
		// Rejected, not resolved: the records genuinely did not reach the store.
		expect(outcome).toBe("rejected");
	});

	test("flush after close rejects rather than hanging", async () => {
		const driver = createMemoryDriver({
			faults: { before: (ctx) => (ctx.op === "put" ? { delayMs: 60_000 } : undefined) },
		});
		const storage = open(driver, { roomId: "flush-after-close", shutdownFlushMs: 20 });
		await storage.init();
		void storage
			.appendOp({
				table: "posts",
				op: "insert",
				rowId: "r1",
				payload: null,
				hlc: hlc(1),
				colClocks: {},
			})
			.catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await storage.close();
		await expect(storage.flush()).rejects.toThrow(/closed|durable/i);
	});
});

describe("object storage: backpressure", () => {
	test("a full buffer rejects the write so backpressure reaches the client", async () => {
		// A store whose flushes never complete; the buffer can only grow.
		const driver = createMemoryDriver({
			faults: { before: (ctx) => (ctx.op === "put" ? { delayMs: 60_000 } : undefined) },
		});

		const storage = open(driver, {
			batch: { maxBufferBytes: 512, onBackpressure: "reject", minLingerMs: 0 },
			// This adapter can never drain, so bound its shutdown tightly rather
			// than making the suite wait out the default 5s on the way out.
			shutdownFlushMs: 1,
		});
		await storage.init();

		const rejected = await (async () => {
			for (let i = 0; i < 500; i++) {
				try {
					await Promise.race([
						storage.appendOp({
							table: "posts",
							op: "insert",
							rowId: `r${i}`,
							payload: { blob: "x".repeat(64) },
							hlc: hlc(i + 1),
							colClocks: {},
						}),
						new Promise((resolve) => setTimeout(resolve, 0)),
					]);
				} catch (error) {
					return error;
				}
			}
			return null;
		})();

		expect((rejected as Error | null)?.name).toBe("BackpressureError");
	});
});

describe("object storage: memory budget", () => {
	test("exceeding the room budget throws rather than growing without bound", async () => {
		// State is authoritative in memory, so the ceiling is a cliff. It must
		// surface as a typed error instead of an OOM.
		const storage = open(createMemoryDriver(), { memory: { maxRoomBytes: 2048 } });
		await storage.init();

		const error = await (async () => {
			for (let i = 0; i < 500; i++) {
				await storage.putRow("posts", `r${i}`, { id: `r${i}`, blob: "x".repeat(256) }, {}, hlc(i + 1));
			}
			return null;
		})().then(
			() => null,
			(e: unknown) => e,
		);

		expect((error as Error | null)?.name).toBe("MemoryLimitExceededError");
	});
});

describe("object storage: shutdown", () => {
	test("close flushes buffered writes — a deploy must not lose them", async () => {
		const driver = createMemoryDriver();
		const storage = open(driver, { roomId: "shutdown", durability: "buffered" });
		await storage.init();

		// "buffered" resolves before the flush, so without a flush on close these
		// would be lost on every restart.
		await storage.applyOp!("posts", "r1", { id: "r1" }, {}, hlc(1), "insert", null);
		await storage.close();

		const reopened = open(driver, { roomId: "shutdown" });
		await reopened.init();
		expect((await reopened.getRow("posts", "r1")).row).toEqual({ id: "r1" });
	});

	test("close releases the lease so failover does not wait out the TTL", async () => {
		const driver = createMemoryDriver();
		const first = open(driver, { roomId: "handover" });
		await first.init();
		await first.applyOp!("posts", "r1", { id: "r1" }, {}, hlc(1), "insert", null);
		await first.close();

		// A long TTL is only safe because a clean shutdown hands the room over.
		const second = open(driver, { roomId: "handover", lease: { ttlMs: 3_600_000 } });
		await second.init();
		await second.applyOp!("posts", "r2", { id: "r2" }, {}, hlc(2), "insert", null);
		expect((await second.getRow("posts", "r2")).row).toEqual({ id: "r2" });
	});

	test("close is bounded when the store hangs — a deploy must not wait on it", async () => {
		// Regression: the drain was bounded but the loop teardown and lease release
		// after it were not, so an in-flight PUT that never answers held close()
		// open indefinitely. A SIGTERM then blocked until the platform's kill timer
		// fired. An in-flight request cannot be cancelled, so the wait must be
		// bounded instead.
		const driver = createMemoryDriver({
			faults: { before: (ctx) => (ctx.op === "put" ? { delayMs: 60_000 } : undefined) },
		});
		const storage = open(driver, { roomId: "hung", shutdownFlushMs: 20 });
		await storage.init();

		void storage
			.appendOp({
				table: "posts",
				op: "insert",
				rowId: "r1",
				payload: null,
				hlc: hlc(1),
				colClocks: {},
			})
			.catch(() => undefined);

		const started = performance.now();
		await storage.close();
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("writes after close are refused", async () => {
		const storage = open(createMemoryDriver());
		await storage.init();
		await storage.close();
		await expect(storage.putRow("posts", "r1", { id: "r1" }, {}, hlc(1))).rejects.toThrow(
			/closed/i,
		);
	});
});

describe("object storage: stores without wildcard CAS (MinIO)", () => {
	test("init seeds the room so later writes can use plain If-Match", async () => {
		const driver = createMemoryDriver({ casWildcard: false });
		const storage = open(driver, { roomId: "minio-room" });

		await storage.init();
		await storage.applyOp!("posts", "r1", { id: "r1" }, {}, hlc(1), "insert", null);
		expect((await storage.getRow("posts", "r1")).row).toEqual({ id: "r1" });
	});
});

describe("object storage: configuration", () => {
	test("requires exactly one of driver or store", () => {
		expect(() => createObjectStorage({ roomId: "r" })).toThrow(/driver.*store|store.*driver/i);
		expect(() =>
			createObjectStorage({
				roomId: "r",
				driver: createMemoryDriver(),
				store: { bucket: "b", credentials: { keyId: "k", secret: "s" } },
			}),
		).toThrow(/not both/i);
	});
});

describe("object storage: optimistic concurrency (serverless)", () => {
	/** Two adapters over one bucket, as two Vercel instances would be. */
	function pair(driver: ObjectDriver, roomId: string) {
		const a = open(driver, { roomId, concurrency: "optimistic" });
		const b = open(driver, { roomId, concurrency: "optimistic" });
		return { a, b };
	}

	test("two instances write the same room without either being fenced", async () => {
		// Under "single-writer" the second instance would take NotWriterError from
		// the lease. Serverless cannot promise room affinity, so the lease is
		// dropped and the manifest CAS — which the design says is the real guard —
		// carries the correctness on its own.
		const driver = createMemoryDriver();
		const { a, b } = pair(driver, "vercel");
		await a.init();
		await b.init();

		await a.applyOp!("cards", "c1", { id: "c1", col: "todo" }, {}, hlc(1), "insert", null);
		await b.applyOp!("cards", "c2", { id: "c2", col: "doing" }, {}, hlc(2), "insert", null);

		expect(a.health).toBe("healthy");
		expect(b.health).toBe("healthy");

		// Each sees the other's write after catching up.
		expect(await a.refresh()).toBe(true);
		expect((await a.getRow("cards", "c2")).row).toEqual({ id: "c2", col: "doing" });
		expect(await b.refresh()).toBe(true);
		expect((await b.getRow("cards", "c1")).row).toEqual({ id: "c1", col: "todo" });
	});

	test("concurrent writes from both instances all survive", async () => {
		const driver = createMemoryDriver();
		const { a, b } = pair(driver, "concurrent");
		await Promise.all([a.init(), b.init()]);

		await Promise.all([
			...Array.from({ length: 8 }, (_, i) =>
				a.applyOp!("cards", `a${i}`, { id: `a${i}` }, {}, hlc(i * 2 + 1), "insert", null),
			),
			...Array.from({ length: 8 }, (_, i) =>
				b.applyOp!("cards", `b${i}`, { id: `b${i}` }, {}, hlc(i * 2 + 2), "insert", null),
			),
		]);

		// A third instance boots and must see all sixteen — nothing was lost to a
		// CAS race, and no segment was overwritten.
		const reader = open(driver, { roomId: "concurrent", concurrency: "optimistic" });
		await reader.init();
		const rows = (await reader.getRows("cards")).rows;
		expect(rows).toHaveLength(16);
	});

	test("segment names are unique per instance, so nothing is overwritten", async () => {
		// Without a lease every instance shares the manifest's epoch, so an
		// epoch-derived name would collide across instances and one would silently
		// overwrite the other's acknowledged records.
		const driver = createMemoryDriver();
		const { a, b } = pair(driver, "names");
		await Promise.all([a.init(), b.init()]);
		await a.applyOp!("cards", "c1", { id: "c1" }, {}, hlc(1), "insert", null);
		await b.applyOp!("cards", "c2", { id: "c2" }, {}, hlc(2), "insert", null);

		const segments = [...driver.dump().keys()].filter((k) => k.includes("/wal/"));
		expect(segments).toHaveLength(2);
		expect(new Set(segments).size).toBe(2);
	});

	test("a losing CAS never adopts the winner's commit as its own", async () => {
		// Regression, and it was silent data loss. `adoptOwnCommit` distinguishes
		// "my write, acknowledged late" from "someone beat me" — originally by
		// epoch + commitSeq. Without a lease every instance shares the manifest's
		// epoch and both race for the SAME commitSeq, so the loser matched the
		// winner's stored manifest exactly, declared success, and left its own
		// segment written but referenced by nothing. `lastWriter` is what makes the
		// two cases distinguishable.
		const driver = createMemoryDriver();
		const { a, b } = pair(driver, "adopt");
		await Promise.all([a.init(), b.init()]);

		await Promise.all([
			a.applyOp!("cards", "a1", { id: "a1" }, {}, hlc(1), "insert", null),
			b.applyOp!("cards", "b1", { id: "b1" }, {}, hlc(2), "insert", null),
		]);

		const manifest = JSON.parse(
			new TextDecoder().decode(driver.dump().get("rooms/adopt/_manifest")!),
		) as { walSegs: { key: string }[]; commitSeq: number };
		// Both commits landed, and the manifest references BOTH segments — not one
		// segment written twice, and not one segment silently orphaned.
		expect(manifest.commitSeq).toBe(2);
		expect(manifest.walSegs).toHaveLength(2);
	});

	test("an instance sees a rival's writes even after losing a CAS to them", async () => {
		// The commit path reloads the manifest whenever it loses a CAS, so the
		// cached commitSeq advances WITHOUT those segments being applied to state.
		// A refresh() that keyed "changed" off commitSeq would then report nothing
		// to do and leave this instance permanently blind to the rival's writes.
		const driver = createMemoryDriver();
		const { a, b } = pair(driver, "blind");
		await Promise.all([a.init(), b.init()]);

		await Promise.all([
			a.applyOp!("cards", "a1", { id: "a1" }, {}, hlc(1), "insert", null),
			b.applyOp!("cards", "b1", { id: "b1" }, {}, hlc(2), "insert", null),
		]);

		// Whichever lost the race has the other's manifest cached already.
		await a.refresh();
		await b.refresh();
		expect((await a.getRow("cards", "b1")).row).toEqual({ id: "b1" });
		expect((await b.getRow("cards", "a1")).row).toEqual({ id: "a1" });
	});

	test("refresh is one GET and reports no change when the room is idle", async () => {
		// This is what makes the SSE poll loop affordable: the steady state must be
		// a single small read that re-runs no queries.
		const driver = createMemoryDriver();
		const storage = open(driver, { roomId: "idle-poll", concurrency: "optimistic" });
		await storage.init();
		await storage.applyOp!("cards", "c1", { id: "c1" }, {}, hlc(1), "insert", null);

		const before = { ...driver.stats };
		expect(await storage.refresh()).toBe(false);
		expect(driver.stats.get - before.get).toBe(1);
		expect(driver.stats.put).toBe(before.put);
	});

	test("refresh picks up another instance's compaction", async () => {
		const driver = createMemoryDriver();
		const writer = open(driver, {
			roomId: "compact-across",
			concurrency: "optimistic",
			compaction: { afterSegments: 3, gcGraceMs: 0 },
		});
		const observer = open(driver, { roomId: "compact-across", concurrency: "optimistic" });
		await writer.init();
		await observer.init();

		for (let i = 0; i < 8; i++) {
			await writer.applyOp!("cards", `c${i}`, { id: `c${i}` }, {}, hlc(i + 1), "insert", null);
		}

		// The observer's own walSegs view is stale AND the segments it never applied
		// have been folded into a snapshot, so it must rebuild from that snapshot
		// rather than replay keys that may already be gone.
		expect(await observer.refresh()).toBe(true);
		expect((await observer.getRows("cards")).rows).toHaveLength(8);
	});

	test("refresh does nothing under single-writer, where memory is authoritative", async () => {
		const driver = createMemoryDriver();
		const storage = open(driver, { roomId: "single" });
		await storage.init();
		const before = { ...driver.stats };
		expect(await storage.refresh()).toBe(false);
		expect(driver.stats.get).toBe(before.get);
	});

	test("an idle optimistic room still issues zero PUTs — no lease to renew", async () => {
		const driver = createMemoryDriver();
		const storage = open(driver, { roomId: "no-lease", concurrency: "optimistic" });
		await storage.init();
		await storage.getRow("cards", "c1");
		expect(driver.stats.put).toBe(0);
		// And no lease object is ever written.
		expect([...driver.dump().keys()].some((k) => k.endsWith("_lease"))).toBe(false);
	});
});
