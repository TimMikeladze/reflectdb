import { describe, expect, test } from "bun:test";
import { EagerBuffer } from "../../src/server/eager-buffer.ts";
import type { StorageAdapter, OpLogEntry } from "../../src/server/handler.ts";
import { ensureAtomicApplyOp } from "../../src/server/handler.ts";

function makeEntry(table: string, rowId: string): OpLogEntry {
	return {
		table,
		op: "insert",
		rowId,
		payload: { title: "test" },
		hlc: "0000000000001000000.0000.server:1",
		colClocks: { _row: "0000000000001000000.0000.server:1" },
	};
}

function createMockStorage(): StorageAdapter & { ops: OpLogEntry[] } {
	const ops: OpLogEntry[] = [];
	return {
		ops,
		async getRow() {
			return { row: null, rowHlc: null, colClocks: {} };
		},
		async putRow() {},
		async getRows() {
			return { rows: [], colClocks: {} };
		},
		async appendOp(entry) {
			ops.push(entry);
		},
		async getOpsSince() {
			return [];
		},
		async deleteOpsBefore() {
			return 0;
		},
		async reserveOp() {
			return true;
		},
		async getMeta() {
			return null;
		},
		async setMeta() {},
	};
}

describe("EagerBuffer concurrent flush", () => {
	test("concurrent flush waits instead of skipping", async () => {
		const buffer = new EagerBuffer();
		const storage = createMockStorage();
		buffer.setStorage(storage);

		buffer.push("posts", { entry: makeEntry("posts", "r1") });
		buffer.push("posts", { entry: makeEntry("posts", "r2") });

		// Start two flushes simultaneously
		const [count1, count2] = await Promise.all([buffer.flush(), buffer.flush()]);

		// Both should return the same count (they share the same flush)
		expect(count1).toBe(2);
		expect(count2).toBe(2);
		expect(storage.ops.length).toBe(2);
	});

	test("close flushes all remaining ops", async () => {
		const buffer = new EagerBuffer();
		const storage = createMockStorage();
		buffer.setStorage(storage);

		buffer.push("posts", { entry: makeEntry("posts", "r1") });
		buffer.push("posts", { entry: makeEntry("posts", "r2") });

		await buffer.close();

		expect(storage.ops.length).toBe(2);
	});

	test("ops buffered during flush are not lost", async () => {
		const buffer = new EagerBuffer();
		const storage = createMockStorage();
		buffer.setStorage(storage);

		buffer.push("posts", { entry: makeEntry("posts", "r1") });

		// Start flush
		const flush1 = buffer.flush();

		// Buffer more ops during flush (concurrent callers get same promise)
		const flush2 = buffer.flush();

		await Promise.all([flush1, flush2]);

		// Now add another op after flush completes
		buffer.push("posts", { entry: makeEntry("posts", "r2") });
		await buffer.flush();

		expect(storage.ops.length).toBe(2);
	});

	test("requeues ops on transient storage failure", async () => {
		const buffer = new EagerBuffer();
		const storage = createMockStorage();
		let attempt = 0;
		storage.applyOp = async (table, rowId, row, colClocks, hlc, opType, payload) => {
			attempt++;
			if (attempt === 1) throw new Error("transient");
			storage.ops.push({ table, op: opType, rowId, payload, hlc, colClocks });
		};
		buffer.setStorage(storage);

		buffer.push("posts", { entry: makeEntry("posts", "r1") });
		const first = await buffer.flush();
		expect(first).toBe(0);
		// Op still buffered for retry
		expect(buffer.queryPendingCount("posts")).toBe(1);

		const second = await buffer.flush();
		expect(second).toBe(1);
		expect(storage.ops.length).toBe(1);
		expect(buffer.queryPendingCount("posts")).toBe(0);
	});
});

describe("ensureAtomicApplyOp", () => {
	test("returns a shimmed wrapper when the adapter lacks applyOp", async () => {
		const storage = createMockStorage();
		expect(storage.applyOp).toBeUndefined();
		const wrapped = ensureAtomicApplyOp(storage);
		expect(typeof wrapped.applyOp).toBe("function");
		// The caller's adapter is never mutated — passing the same object to a
		// second server (or asserting on it in a test) sees what it built.
		expect(storage.applyOp).toBeUndefined();

		await wrapped.applyOp!(
			"t",
			"r1",
			{ a: 1 },
			{ _row: "h" },
			"h",
			"insert",
			{ a: 1 },
		);
		expect(storage.ops).toHaveLength(1);
		expect(storage.ops[0]!.rowId).toBe("r1");
	});

	test("preserves existing atomic applyOp", () => {
		const calls: string[] = [];
		const storage = createMockStorage();
		storage.applyOp = async () => {
			calls.push("custom");
		};
		const wrapped = ensureAtomicApplyOp(storage);
		// Returned as-is, not wrapped/replaced
		expect(wrapped).toBe(storage);
		void wrapped.applyOp!("t", "r", null, {}, "h", "delete", null);
		expect(calls).toEqual(["custom"]);
	});
});
