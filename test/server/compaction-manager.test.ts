import { describe, expect, test } from "bun:test";
import { CompactionManager } from "../../src/server/compaction-manager.ts";
import type { SyncEvent } from "../../src/server/types.ts";

function makeStorage() {
	const meta = new Map<string, string>();
	const deletedBefore: string[] = [];
	let lockHeld = false;
	const adapter = {
		getMeta: async (k: string) => meta.get(k) ?? null,
		setMeta: async (k: string, v: string) => {
			meta.set(k, v);
		},
		deleteOpsBefore: async (cutoff: string) => {
			deletedBefore.push(cutoff);
			return 5;
		},
		tryLock: async () => {
			if (lockHeld) return false;
			lockHeld = true;
			return true;
		},
		unlock: async () => {
			lockHeld = false;
		},
	};
	return { adapter, meta, deletedBefore, isLocked: () => lockHeld };
}

describe("CompactionManager", () => {
	test("returns 0 when no storage", async () => {
		const events: SyncEvent[] = [];
		const cm = new CompactionManager(null, (e) => events.push(e));
		expect(await cm.runCompaction(0)).toBe(0);
		expect(events.length).toBe(0);
	});

	test("enforces MIN_COMPACTION_AGE_MS floor", async () => {
		const { adapter, deletedBefore } = makeStorage();
		const events: SyncEvent[] = [];
		const cm = new CompactionManager(adapter as never, (e) => events.push(e));

		// minOpAge=0 should be raised to MIN_COMPACTION_AGE_MS (30s)
		const before = Date.now();
		await cm.runCompaction(0);
		const cutoff = deletedBefore[0]!;
		const cutoffMs = Number.parseInt(cutoff.split(".")[0]!, 10);
		expect(before - cutoffMs).toBeGreaterThanOrEqual(30_000 - 50);
	});

	test("refuses to move cutoff backwards", async () => {
		const { adapter } = makeStorage();
		const events: SyncEvent[] = [];
		const cm = new CompactionManager(adapter as never, (e) => events.push(e));

		await cm.runCompaction(60_000); // older cutoff
		await cm.runCompaction(120_000); // would move backwards
		const compactionEvents = events.filter((e) => e.type === "compaction");
		// Second run rejected — emits 0
		expect(compactionEvents.length).toBe(2);
		expect(compactionEvents[1]).toEqual({ type: "compaction", deletedOps: 0 });
	});

	test("releases lock even on inner throw", async () => {
		const meta = new Map<string, string>();
		let lockHeld = false;
		const adapter = {
			getMeta: async (k: string) => meta.get(k) ?? null,
			setMeta: async () => {
				throw new Error("meta failure");
			},
			deleteOpsBefore: async () => 0,
			tryLock: async () => {
				lockHeld = true;
				return true;
			},
			unlock: async () => {
				lockHeld = false;
			},
		};
		const cm = new CompactionManager(adapter as never, () => {});
		await expect(cm.runCompaction(0)).rejects.toThrow();
		expect(lockHeld).toBe(false);
	});

	test("skips when lock not acquired", async () => {
		const adapter = {
			getMeta: async () => null,
			setMeta: async () => {},
			deleteOpsBefore: async () => 999,
			tryLock: async () => false,
			unlock: async () => {},
		};
		const events: SyncEvent[] = [];
		const cm = new CompactionManager(adapter as never, (e) => events.push(e));
		expect(await cm.runCompaction(0)).toBe(0);
		expect(events).toEqual([{ type: "compaction", deletedOps: 0 }]);
	});

	test("ensureCutoffLoaded reads from storage once", async () => {
		const meta = new Map<string, string>([["compactionCutoff", "0000000001234567890.9999.compaction"]]);
		let calls = 0;
		const adapter = {
			getMeta: async (k: string) => {
				calls++;
				return meta.get(k) ?? null;
			},
			setMeta: async () => {},
			deleteOpsBefore: async () => 0,
			tryLock: async () => true,
			unlock: async () => {},
		};
		const cm = new CompactionManager(adapter as never, () => {});
		await cm.ensureCutoffLoaded();
		await cm.ensureCutoffLoaded();
		expect(calls).toBe(1);
		expect(cm.getCutoff()).toBe("0000000001234567890.9999.compaction");
	});
});
