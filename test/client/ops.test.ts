import { describe, expect, test } from "bun:test";
import { createOpCreator } from "../../src/client/ops.ts";
import { unpackHlc } from "../../src/core/hlc.ts";

describe("OpCreator", () => {
	test("insert creates op with correct type", () => {
		const creator = createOpCreator("client:test");
		const op = creator.insert("posts", "row-1", { title: "hello" });

		expect(op.table).toBe("posts");
		expect(op.op).toBe("insert");
		expect(op.rowId).toBe("row-1");
		expect(op.payload).toEqual({ title: "hello" });
		expect(op.id).toBeTruthy();
		expect(op.hlc).toBeTruthy();
	});

	test("update creates op with correct type", () => {
		const creator = createOpCreator("client:test");
		const op = creator.update("posts", "row-1", { title: "updated" });

		expect(op.op).toBe("update");
		expect(op.payload).toEqual({ title: "updated" });
	});

	test("delete creates op with null payload", () => {
		const creator = createOpCreator("client:test");
		const op = creator.delete("posts", "row-1");

		expect(op.op).toBe("delete");
		expect(op.payload).toBeNull();
	});

	test("HLC advances monotonically", () => {
		const creator = createOpCreator("client:test");
		const op1 = creator.insert("posts", "r1", {});
		const op2 = creator.insert("posts", "r2", {});

		expect(op2.hlc > op1.hlc).toBe(true);
	});

	test("HLC contains the nodeId", () => {
		const creator = createOpCreator("client:abc");
		const op = creator.insert("posts", "r1", {});
		const hlc = unpackHlc(op.hlc);
		expect(hlc.nodeId).toBe("client:abc");
	});

	test("each op gets a unique id", () => {
		const creator = createOpCreator("client:test");
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(creator.insert("t", `r${i}`, {}).id);
		}
		expect(ids.size).toBe(100);
	});

	test("createBatch assigns batchId to all ops", () => {
		const creator = createOpCreator("client:test");
		const ops = creator.createBatch([
			{ table: "posts", op: "insert", rowId: "r1", payload: { title: "a" } },
			{ table: "posts", op: "insert", rowId: "r2", payload: { title: "b" } },
			{ table: "posts", op: "insert", rowId: "r3", payload: { title: "c" } },
		]);

		expect(ops.length).toBe(3);
		const batchId = ops[0]!.batchId;
		expect(batchId).toBeTruthy();
		expect(ops.every((o) => o.batchId === batchId)).toBe(true);
	});

	test("createBatch assigns correct batchSize and batchSeq", () => {
		const creator = createOpCreator("client:test");
		const ops = creator.createBatch([
			{ table: "t", op: "insert", rowId: "r1", payload: {} },
			{ table: "t", op: "update", rowId: "r2", payload: {} },
		]);

		expect(ops[0]!.batchSize).toBe(2);
		expect(ops[0]!.batchSeq).toBe(0);
		expect(ops[1]!.batchSize).toBe(2);
		expect(ops[1]!.batchSeq).toBe(1);
	});

	test("getHlc returns current clock state", () => {
		const creator = createOpCreator("client:test");
		const before = creator.getHlc();
		expect(before.ms).toBe(0); // initial

		creator.insert("t", "r1", {});
		const after = creator.getHlc();
		expect(after.ms).toBeGreaterThan(0);
	});
});
