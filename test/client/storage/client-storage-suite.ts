import { describe, expect, test, beforeEach } from "bun:test";
import type { ClientStorageAdapter } from "../../../src/client/storage/types.ts";
import type { LocalRow, PendingOp } from "../../../src/client/store.ts";
import { packHlc } from "../../../src/core/hlc.ts";

const hlc1 = packHlc({ ms: 1000, counter: 0, nodeId: "client:a" });

function makeRow(table: string, rowId: string, data: Record<string, unknown> = {}): LocalRow {
	return { table, rowId, data, colClocks: { _row: hlc1 }, serverHlc: hlc1 };
}

function makePendingOp(id: string): PendingOp {
	return {
		op: {
			id,
			table: "posts",
			op: "insert",
			rowId: `row-${id}`,
			payload: { title: "hello" },
			hlc: hlc1,
		},
		status: "pending",
		rejectedReason: null,
		createdAt: Date.now(),
	};
}

export function runClientStorageSuite(name: string, createAdapter: () => ClientStorageAdapter) {
	describe(`ClientStorageAdapter: ${name}`, () => {
		let adapter: ClientStorageAdapter;

		beforeEach(async () => {
			adapter = createAdapter();
			await adapter.clear();
		});

		// ── Rows ────────────────────────────────────────────────────────

		describe("rows", () => {
			test("getRows returns empty for empty table", async () => {
				const rows = await adapter.getRows("posts");
				expect(rows).toEqual([]);
			});

			test("putRow + getRows returns stored row", async () => {
				const row = makeRow("posts", "r1", { title: "hello" });
				await adapter.putRow("posts", "r1", row);

				const rows = await adapter.getRows("posts");
				expect(rows).toHaveLength(1);
				expect(rows[0]!.data).toEqual({ title: "hello" });
			});

			test("getAllRows returns rows across tables", async () => {
				await adapter.putRow("posts", "r1", makeRow("posts", "r1", { title: "a" }));
				await adapter.putRow("comments", "c1", makeRow("comments", "c1", { body: "b" }));

				const all = await adapter.getAllRows();
				expect(all).toHaveLength(2);
			});

			test("putRow overwrites existing row", async () => {
				await adapter.putRow("posts", "r1", makeRow("posts", "r1", { title: "v1" }));
				await adapter.putRow("posts", "r1", makeRow("posts", "r1", { title: "v2" }));

				const rows = await adapter.getRows("posts");
				expect(rows).toHaveLength(1);
				expect(rows[0]!.data).toEqual({ title: "v2" });
			});

			test("deleteRow removes a row", async () => {
				await adapter.putRow("posts", "r1", makeRow("posts", "r1", { title: "gone" }));
				await adapter.deleteRow("posts", "r1");

				const rows = await adapter.getRows("posts");
				expect(rows).toHaveLength(0);
			});

			test("clearTable removes all rows for a table", async () => {
				await adapter.putRow("posts", "r1", makeRow("posts", "r1"));
				await adapter.putRow("posts", "r2", makeRow("posts", "r2"));
				await adapter.putRow("comments", "c1", makeRow("comments", "c1"));

				await adapter.clearTable("posts");

				expect(await adapter.getRows("posts")).toHaveLength(0);
				expect(await adapter.getRows("comments")).toHaveLength(1);
			});

			test("tables are isolated", async () => {
				await adapter.putRow("posts", "r1", makeRow("posts", "r1", { title: "post" }));
				await adapter.putRow("comments", "r1", makeRow("comments", "r1", { body: "comment" }));

				const posts = await adapter.getRows("posts");
				const comments = await adapter.getRows("comments");

				expect(posts).toHaveLength(1);
				expect(posts[0]!.data).toEqual({ title: "post" });
				expect(comments).toHaveLength(1);
				expect(comments[0]!.data).toEqual({ body: "comment" });
			});
		});

		// ── Pending Ops ─────────────────────────────────────────────────

		describe("pending ops", () => {
			test("getPendingOps returns empty initially", async () => {
				const ops = await adapter.getPendingOps();
				expect(ops).toEqual([]);
			});

			test("putPendingOps + getPendingOps roundtrip", async () => {
				const ops = [makePendingOp("op-1"), makePendingOp("op-2")];
				await adapter.putPendingOps(ops);

				const result = await adapter.getPendingOps();
				expect(result).toHaveLength(2);
				expect(result[0]!.op.id).toBe("op-1");
				expect(result[1]!.op.id).toBe("op-2");
			});

			test("putPendingOps replaces all ops", async () => {
				await adapter.putPendingOps([makePendingOp("op-1")]);
				await adapter.putPendingOps([makePendingOp("op-2"), makePendingOp("op-3")]);

				const result = await adapter.getPendingOps();
				expect(result).toHaveLength(2);
				expect(result[0]!.op.id).toBe("op-2");
			});

			test("appendPendingOps adds ops without clearing", async () => {
				await adapter.putPendingOps([makePendingOp("op-1")]);
				await adapter.appendPendingOps([makePendingOp("op-2"), makePendingOp("op-3")]);

				const result = await adapter.getPendingOps();
				expect(result).toHaveLength(3);
				expect(result[0]!.op.id).toBe("op-1");
				expect(result[1]!.op.id).toBe("op-2");
				expect(result[2]!.op.id).toBe("op-3");
			});

			test("appendPendingOps works on empty store", async () => {
				await adapter.appendPendingOps([makePendingOp("op-1")]);

				const result = await adapter.getPendingOps();
				expect(result).toHaveLength(1);
				expect(result[0]!.op.id).toBe("op-1");
			});

			test("updatePendingOps updates existing ops in place", async () => {
				const op1 = makePendingOp("op-1");
				const op2 = makePendingOp("op-2");
				await adapter.putPendingOps([op1, op2]);

				const updatedOp1: PendingOp = {
					...op1,
					status: "rejected",
					rejectedReason: "server_conflict",
				};
				await adapter.updatePendingOps([updatedOp1]);

				const result = await adapter.getPendingOps();
				expect(result).toHaveLength(2);
				const found = result.find((p) => p.op.id === "op-1");
				expect(found!.status).toBe("rejected");
				expect(found!.rejectedReason).toBe("server_conflict");

				// op-2 should be unchanged
				const op2Result = result.find((p) => p.op.id === "op-2");
				expect(op2Result!.status).toBe("pending");
			});

			test("removePendingOps removes specific ops", async () => {
				await adapter.putPendingOps([
					makePendingOp("op-1"),
					makePendingOp("op-2"),
					makePendingOp("op-3"),
				]);
				await adapter.removePendingOps(["op-1", "op-3"]);

				const result = await adapter.getPendingOps();
				expect(result).toHaveLength(1);
				expect(result[0]!.op.id).toBe("op-2");
			});

			test("clearPendingOps removes all", async () => {
				await adapter.putPendingOps([makePendingOp("op-1"), makePendingOp("op-2")]);
				await adapter.clearPendingOps();

				const result = await adapter.getPendingOps();
				expect(result).toHaveLength(0);
			});
		});

		// ── Meta ────────────────────────────────────────────────────────

		describe("meta", () => {
			test("getMeta returns null for unknown key", async () => {
				expect(await adapter.getMeta("unknown")).toBeNull();
			});

			test("setMeta + getMeta roundtrip", async () => {
				await adapter.setMeta("serverHlc", "some-hlc-value");
				expect(await adapter.getMeta("serverHlc")).toBe("some-hlc-value");
			});

			test("setMeta overwrites existing value", async () => {
				await adapter.setMeta("key", "v1");
				await adapter.setMeta("key", "v2");
				expect(await adapter.getMeta("key")).toBe("v2");
			});

			test("deleteMeta removes a key", async () => {
				await adapter.setMeta("key", "value");
				await adapter.deleteMeta("key");
				expect(await adapter.getMeta("key")).toBeNull();
			});
		});

		// ── Clear ───────────────────────────────────────────────────────

		describe("clear", () => {
			test("clear removes all data", async () => {
				await adapter.putRow("posts", "r1", makeRow("posts", "r1"));
				await adapter.putPendingOps([makePendingOp("op-1")]);
				await adapter.setMeta("key", "value");

				await adapter.clear();

				expect(await adapter.getRows("posts")).toHaveLength(0);
				expect(await adapter.getPendingOps()).toHaveLength(0);
				expect(await adapter.getMeta("key")).toBeNull();
			});
		});
	});
}
