import { describe, expect, test } from "bun:test";
import { ClientStore } from "../../src/client/store.ts";
import { packHlc } from "../../src/core/hlc.ts";
import type { ClientOp } from "../../src/core/types.ts";

const hlc1 = packHlc({ ms: 1000, counter: 0, nodeId: "client:a" });
const hlc2 = packHlc({ ms: 2000, counter: 0, nodeId: "client:b" });
const hlc3 = packHlc({ ms: 3000, counter: 0, nodeId: "client:c" });

function makeOp(overrides: Partial<ClientOp> = {}): ClientOp {
	return {
		id: crypto.randomUUID(),
		table: "posts",
		op: "insert",
		rowId: "row-1",
		payload: { title: "hello" },
		hlc: hlc1,
		...overrides,
	};
}

describe("ClientStore - Pending Ops", () => {
	test("addPendingOp and getPendingOps", () => {
		const store = new ClientStore();
		const op = makeOp();
		store.addPendingOp(op);
		expect(store.getPendingOps().length).toBe(1);
		expect(store.getPendingOps()[0]!.op.id).toBe(op.id);
	});

	test("markSynced removes ops", () => {
		const store = new ClientStore();
		const op1 = makeOp({ id: "op-1" });
		const op2 = makeOp({ id: "op-2" });
		store.addPendingOp(op1);
		store.addPendingOp(op2);
		store.markSynced(["op-1"]);
		expect(store.getPendingOps().length).toBe(1);
		expect(store.getPendingOps()[0]!.op.id).toBe("op-2");
	});

	test("markRejected sets status", () => {
		const store = new ClientStore();
		const op = makeOp({ id: "op-rej" });
		store.addPendingOp(op);
		store.markRejected("op-rej", "server_conflict");
		expect(store.getPendingOps().length).toBe(0); // rejected ops filtered out
	});

	test("rejectBatch rejects all ops in batch", () => {
		const store = new ClientStore();
		store.addPendingOp(makeOp({ id: "b1", batchId: "batch-1" }));
		store.addPendingOp(makeOp({ id: "b2", batchId: "batch-1" }));
		store.addPendingOp(makeOp({ id: "b3", batchId: "batch-2" }));
		store.rejectBatch("batch-1", "batch_too_large");
		expect(store.getPendingOps().length).toBe(1);
		expect(store.getPendingOps()[0]!.op.id).toBe("b3");
	});

	test("clearRejected removes rejected ops", () => {
		const store = new ClientStore();
		store.addPendingOp(makeOp({ id: "r1" }));
		store.markRejected("r1", "clock_drift");
		store.clearRejected();
		// Should be completely empty
		expect(store.getPendingOps().length).toBe(0);
	});

	test("autoTrimRejected removes old rejected ops", () => {
		const store = new ClientStore();
		// Add an op with a very old createdAt
		const op = makeOp({ id: "old-reject" });
		store.addPendingOp(op);

		// Manually set createdAt to >60s ago by accessing internals
		const allOps = (store as unknown as { pendingOps: Array<{ createdAt: number }> }).pendingOps;
		allOps[0]!.createdAt = Date.now() - 120_000; // 2 minutes ago

		// markRejected triggers autoTrimRejected
		store.markRejected("old-reject", "server_conflict");

		// The old rejected op should have been auto-trimmed
		const remaining = (store as unknown as { pendingOps: Array<{ status: string }> }).pendingOps;
		expect(remaining.filter((p) => p.status === "rejected").length).toBe(0);
	});

	test("autoTrimRejected keeps recent rejected ops", () => {
		const store = new ClientStore();
		const op = makeOp({ id: "recent-reject" });
		store.addPendingOp(op);

		// markRejected triggers autoTrimRejected — but this op is recent
		store.markRejected("recent-reject", "server_conflict");

		// The recent rejected op should still be there (just not in getPendingOps which filters)
		const remaining = (store as unknown as { pendingOps: Array<{ status: string }> }).pendingOps;
		expect(remaining.filter((p) => p.status === "rejected").length).toBe(1);
	});
});

describe("ClientStore - Local Rows", () => {
	test("setRow and getRow", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "hello" }, { _row: hlc1 }, hlc1);
		const row = store.getRow("posts", "r1");
		expect(row).toBeDefined();
		expect(row!.data).toEqual({ title: "hello" });
	});

	test("setRow with null data deletes row", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "hello" }, {}, null);
		store.setRow("posts", "r1", null, {}, null);
		expect(store.getRow("posts", "r1")).toBeUndefined();
	});

	test("getRows returns all rows for a table", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "a" }, {}, null);
		store.setRow("posts", "r2", { title: "b" }, {}, null);
		store.setRow("comments", "r3", { body: "c" }, {}, null);
		expect(store.getRows("posts").length).toBe(2);
		expect(store.getRows("comments").length).toBe(1);
	});

	test("clearTable removes all rows for a table", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "a" }, {}, null);
		store.setRow("posts", "r2", { title: "b" }, {}, null);
		store.setRow("comments", "r3", { body: "c" }, {}, null);
		store.clearTable("posts");
		expect(store.getRows("posts").length).toBe(0);
		expect(store.getRows("comments").length).toBe(1);
	});
});

describe("ClientStore - Snapshots and Deltas", () => {
	test("applySnapshot replaces table data", () => {
		const store = new ClientStore();
		store.setRow("posts", "old", { title: "old" }, {}, null);

		store.applySnapshot(
			"posts",
			[
				{ id: "r1", title: "a" },
				{ id: "r2", title: "b" },
			],
			{
				r1: { _row: hlc1, title: hlc1 },
				r2: { _row: hlc2, title: hlc2 },
			},
		);

		expect(store.getRows("posts").length).toBe(2);
		expect(store.getRow("posts", "old")).toBeUndefined();
		expect(store.getRow("posts", "r1")!.data).toEqual({ id: "r1", title: "a" });
	});

	test("applyDelta insert adds new row", () => {
		const store = new ClientStore();
		store.applyDelta("posts", "insert", "r1", { title: "new" }, hlc1, { _row: hlc1 });
		expect(store.getRow("posts", "r1")!.data).toEqual({ title: "new" });
	});

	test("applyDelta update merges into existing row", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "old", body: "keep" }, { _row: hlc1 }, hlc1);
		store.applyDelta("posts", "update", "r1", { title: "new" }, hlc2, { title: hlc2 });
		const row = store.getRow("posts", "r1");
		expect(row!.data).toEqual({ title: "new", body: "keep" });
	});

	test("applyDelta delete removes row", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "old" }, {}, null);
		store.applyDelta("posts", "delete", "r1", null, hlc1);
		expect(store.getRow("posts", "r1")).toBeUndefined();
	});

	test("applyDelta delete blocks resurrection by older insert (tombstone)", () => {
		const store = new ClientStore();
		// Newer delete first
		store.applyDelta("posts", "delete", "r1", null, hlc3);
		expect(store.getRow("posts", "r1")).toBeUndefined();
		// Older insert arrives late — must be rejected
		store.applyDelta("posts", "insert", "r1", { title: "ghost" }, hlc1);
		expect(store.getRow("posts", "r1")).toBeUndefined();
	});

	test("applyDelta rejects out-of-order older update (per-column HLC)", () => {
		const store = new ClientStore();
		// Row already at hlc3
		store.setRow(
			"posts",
			"r1",
			{ title: "newest" },
			{ _row: hlc3, title: hlc3 },
			hlc3,
		);
		// Older delta arrives late
		store.applyDelta("posts", "update", "r1", { title: "stale" }, hlc1, {
			_row: hlc1,
			title: hlc1,
		});
		// Newer state preserved
		expect(store.getRow("posts", "r1")!.data).toEqual({ title: "newest" });
	});

	test("applyDelta merges per-column when partial cols are newer", () => {
		const store = new ClientStore();
		store.setRow(
			"posts",
			"r1",
			{ title: "old", body: "old" },
			{ _row: hlc2, title: hlc2, body: hlc1 },
			hlc2,
		);
		// Delta with body=hlc3 (newer), title=hlc1 (older)
		store.applyDelta("posts", "update", "r1", { title: "stale", body: "fresh" }, hlc3, {
			_row: hlc3,
			title: hlc1,
			body: hlc3,
		});
		const row = store.getRow("posts", "r1")!;
		expect(row.data).toEqual({ title: "old", body: "fresh" });
		expect(row.colClocks.title).toBe(hlc2);
		expect(row.colClocks.body).toBe(hlc3);
	});

	test("applyDelta rejects stale delete (older than row HLC)", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "alive" }, { _row: hlc3 }, hlc3);
		store.applyDelta("posts", "delete", "r1", null, hlc1);
		// Row still present
		expect(store.getRow("posts", "r1")).toBeDefined();
		expect(store.getRow("posts", "r1")!.data).toEqual({ title: "alive" });
	});

	test("applyDelta accepts newer delete after older insert", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "old" }, { _row: hlc1 }, hlc1);
		store.applyDelta("posts", "delete", "r1", null, hlc3);
		expect(store.getRow("posts", "r1")).toBeUndefined();
	});
});

describe("ClientStore - Revert and Optimistic", () => {
	test("revertOp replaces row with server state", () => {
		const store = new ClientStore();
		const op = makeOp({ id: "op-rev", rowId: "r1" });
		store.addPendingOp(op);
		store.setRow("posts", "r1", { title: "optimistic" }, {}, null);

		store.revertOp("op-rev", { title: "server-truth" });
		expect(store.getRow("posts", "r1")!.data).toEqual({ title: "server-truth" });
		expect(store.getPendingOps().length).toBe(0);
	});

	test("revertOp with null serverRow deletes row", () => {
		const store = new ClientStore();
		const op = makeOp({ id: "op-rev", rowId: "r1", op: "insert" });
		store.addPendingOp(op);
		store.setRow("posts", "r1", { title: "optimistic" }, {}, null);

		store.revertOp("op-rev", null);
		expect(store.getRow("posts", "r1")).toBeUndefined();
	});

	test("applyOptimistic strips serverSet fields", () => {
		const store = new ClientStore();
		store.setTableMeta({ posts: { serverSet: ["orgId"], readonly: [] } });

		const op = makeOp({
			op: "insert",
			rowId: "r1",
			payload: { title: "hello", orgId: "client-org" },
		});
		store.applyOptimistic(op);

		const row = store.getRow("posts", "r1");
		expect(row!.data).toEqual({ title: "hello" });
		expect(row!.data!.orgId).toBeUndefined();
	});

	test("applyOptimistic update merges into existing", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "old", body: "keep" }, { _row: hlc1 }, hlc1);

		const op = makeOp({
			op: "update",
			rowId: "r1",
			payload: { title: "new" },
		});
		store.applyOptimistic(op);

		expect(store.getRow("posts", "r1")!.data).toEqual({ title: "new", body: "keep" });
	});

	test("applyOptimistic delete removes row", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "old" }, {}, null);

		const op = makeOp({ op: "delete", rowId: "r1" });
		store.applyOptimistic(op);
		expect(store.getRow("posts", "r1")).toBeUndefined();
	});
});

describe("ClientStore - Table Meta", () => {
	test("setTableMeta and getTableMeta", () => {
		const store = new ClientStore();
		store.setTableMeta({
			posts: { serverSet: ["orgId"], readonly: ["createdAt"] },
		});
		const meta = store.getTableMeta("posts");
		expect(meta).toEqual({
			serverSet: ["orgId"],
			readonly: ["createdAt"],
			broadcast: "consistent",
			pk: "id",
		});
	});

	test("getTableMeta returns undefined for unknown table", () => {
		const store = new ClientStore();
		expect(store.getTableMeta("unknown")).toBeUndefined();
	});
});
