import { describe, expect, test, beforeEach } from "bun:test";
import type { StorageAdapter } from "../../../src/server/handler.ts";

/**
 * Shared test suite for any StorageAdapter implementation.
 * Call this with a factory function that creates a fresh adapter per test.
 */
export function runStorageAdapterSuite(
	name: string,
	createAdapter: () => StorageAdapter & { close?(): void },
) {
	describe(`StorageAdapter: ${name}`, () => {
		let adapter: StorageAdapter & { close?(): void };

		beforeEach(() => {
			adapter?.close?.();
			adapter = createAdapter();
		});

		// ── getRow / putRow ────────────────────────────────────────────────

		test("getRow returns empty for non-existent row", async () => {
			const result = await adapter.getRow("posts", "missing");
			expect(result.row).toBeNull();
			expect(result.rowHlc).toBeNull();
			expect(result.colClocks).toEqual({});
		});

		test("putRow stores and getRow retrieves a row", async () => {
			await adapter.putRow("posts", "r1", { id: "r1", title: "Hello" }, { title: "hlc1" }, "hlc1");

			const result = await adapter.getRow("posts", "r1");
			expect(result.row).toEqual({ id: "r1", title: "Hello" });
			expect(result.rowHlc).toBe("hlc1");
			expect(result.colClocks).toEqual({ title: "hlc1" });
		});

		test("putRow with null deletes the row", async () => {
			await adapter.putRow("posts", "r1", { id: "r1", title: "Hello" }, {}, "hlc1");
			await adapter.putRow("posts", "r1", null, {}, "hlc2");

			const result = await adapter.getRow("posts", "r1");
			expect(result.row).toBeNull();
		});

		test("putRow updates existing row", async () => {
			await adapter.putRow("posts", "r1", { id: "r1", title: "v1" }, { title: "hlc1" }, "hlc1");
			await adapter.putRow("posts", "r1", { id: "r1", title: "v2" }, { title: "hlc2" }, "hlc2");

			const result = await adapter.getRow("posts", "r1");
			expect(result.row).toEqual({ id: "r1", title: "v2" });
			expect(result.colClocks).toEqual({ title: "hlc2" });
		});

		test("rows in different tables are isolated", async () => {
			await adapter.putRow("posts", "r1", { id: "r1" }, {}, "hlc1");
			await adapter.putRow("comments", "r1", { id: "r1", text: "hi" }, {}, "hlc2");

			const post = await adapter.getRow("posts", "r1");
			expect(post.row).toEqual({ id: "r1" });

			const comment = await adapter.getRow("comments", "r1");
			expect(comment.row).toEqual({ id: "r1", text: "hi" });
		});

		// ── getRows ────────────────────────────────────────────────────────

		test("getRows returns all rows for a table", async () => {
			await adapter.putRow("posts", "r1", { id: "r1", title: "First" }, { title: "h1" }, "h1");
			await adapter.putRow("posts", "r2", { id: "r2", title: "Second" }, { title: "h2" }, "h2");
			await adapter.putRow("comments", "c1", { id: "c1" }, {}, "h3");

			const { rows, colClocks } = await adapter.getRows("posts", {});
			expect(rows.length).toBe(2);
			expect(rows.map((r) => r.title).sort()).toEqual(["First", "Second"]);
			expect(Object.keys(colClocks).sort()).toEqual(["r1", "r2"]);
		});

		test("getRows returns empty for table with no rows", async () => {
			const { rows, colClocks } = await adapter.getRows("empty", {});
			expect(rows).toEqual([]);
			expect(colClocks).toEqual({});
		});

		// ── Batch read / reserve (optional) ────────────────────────────────

		describe("getRowsByIds (optional)", () => {
			test("reads many rows of one table in a single call", async () => {
				if (!adapter.getRowsByIds) return;
				await adapter.putRow("posts", "r1", { id: "r1", t: "a" }, { t: "h1" }, "h1");
				await adapter.putRow("posts", "r2", { id: "r2", t: "b" }, { t: "h2" }, "h2");
				await adapter.putRow("comments", "r3", { id: "r3" }, {}, "h3");

				const found = await adapter.getRowsByIds("posts", ["r1", "r2", "r3"]);
				expect(Object.keys(found).sort()).toEqual(["r1", "r2"]);
				expect(found.r1!.row).toEqual({ id: "r1", t: "a" });
				expect(found.r1!.rowHlc).toBe("h1");
				expect(found.r2!.colClocks).toEqual({ t: "h2" });
			});

			test("returns an empty result for an empty id list", async () => {
				if (!adapter.getRowsByIds) return;
				expect(await adapter.getRowsByIds("posts", [])).toEqual({});
			});
		});

		describe("reserveOps (optional)", () => {
			test("returns only the ids that were fresh", async () => {
				if (!adapter.reserveOps) return;
				expect(await adapter.reserveOp("op-a")).toBe(true);

				const fresh = await adapter.reserveOps(["op-a", "op-b", "op-c"]);
				expect(fresh.sort()).toEqual(["op-b", "op-c"]);

				// A second pass reserves nothing — replay detection is idempotent.
				expect(await adapter.reserveOps(["op-a", "op-b", "op-c"])).toEqual([]);
			});

			test("handles an empty batch", async () => {
				if (!adapter.reserveOps) return;
				expect(await adapter.reserveOps([])).toEqual([]);
			});
		});

		// ── appendOp / getOpsSince ─────────────────────────────────────────

		describe("op log", () => {
			test("appendOp and getOpsSince returns ops after the given HLC", async () => {
				await adapter.appendOp({
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "First" },
					hlc: "0000000000001000000.0000.server:1",
					colClocks: { title: "0000000000001000000.0000.server:1" },
				});

				await adapter.appendOp({
					table: "posts",
					op: "update",
					rowId: "r1",
					payload: { title: "Updated" },
					hlc: "0000000000002000000.0000.server:1",
					colClocks: { title: "0000000000002000000.0000.server:1" },
				});

				await adapter.appendOp({
					table: "comments",
					op: "insert",
					rowId: "c1",
					payload: { text: "hi" },
					hlc: "0000000000003000000.0000.server:1",
					colClocks: { text: "0000000000003000000.0000.server:1" },
				});

				// Get ops since the first one (exclusive), for posts only
				const ops = await adapter.getOpsSince("0000000000001000000.0000.server:1", ["posts"]);

				expect(ops.length).toBe(1);
				expect(ops[0]!.op).toBe("update");
				expect(ops[0]!.payload).toEqual({ title: "Updated" });
			});

			test("getOpsSince with multiple tables", async () => {
				await adapter.appendOp({
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "Post" },
					hlc: "0000000000001000000.0000.server:1",
					colClocks: {},
				});

				await adapter.appendOp({
					table: "comments",
					op: "insert",
					rowId: "c1",
					payload: { text: "Comment" },
					hlc: "0000000000002000000.0000.server:1",
					colClocks: {},
				});

				const ops = await adapter.getOpsSince("0000000000000000000.0000.server:0", [
					"posts",
					"comments",
				]);

				expect(ops.length).toBe(2);
			});

			test("getOpsSince returns ops in HLC order", async () => {
				await adapter.appendOp({
					table: "posts",
					op: "insert",
					rowId: "r2",
					payload: null,
					hlc: "0000000000003000000.0000.server:1",
					colClocks: {},
				});

				await adapter.appendOp({
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: null,
					hlc: "0000000000001000000.0000.server:1",
					colClocks: {},
				});

				const ops = await adapter.getOpsSince("0000000000000000000.0000.server:0", ["posts"]);

				expect(ops[0]!.rowId).toBe("r1");
				expect(ops[1]!.rowId).toBe("r2");
			});

			test("getChangedTablesSince returns distinct tables only (optional)", async () => {
				if (!adapter.getChangedTablesSince) return;
				for (let i = 0; i < 3; i++) {
					await adapter.appendOp({
						table: "posts",
						op: "insert",
						rowId: `r${i}`,
						payload: null,
						hlc: `000000000000200000${i}.0000.server:1`,
						colClocks: {},
					});
				}
				await adapter.appendOp({
					table: "comments",
					op: "insert",
					rowId: "c1",
					payload: null,
					hlc: "0000000000003000000.0000.server:1",
					colClocks: {},
				});

				const changed = await adapter.getChangedTablesSince(
					"0000000000001000000.0000.server:1",
					["posts", "comments", "unrelated"],
				);
				expect(changed.sort()).toEqual(["comments", "posts"]);

				// Nothing newer than the last op.
				expect(
					await adapter.getChangedTablesSince("0000000000009000000.0000.server:1", [
						"posts",
						"comments",
					]),
				).toEqual([]);
			});

			test("getOplogHead reports the highest HLC (optional)", async () => {
				if (!adapter.getOplogHead) return;
				expect(await adapter.getOplogHead(["posts"])).toBeNull();

				await adapter.appendOp({
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: null,
					hlc: "0000000000001000000.0000.server:1",
					colClocks: {},
				});
				await adapter.appendOp({
					table: "posts",
					op: "insert",
					rowId: "r2",
					payload: null,
					hlc: "0000000000003000000.0000.server:1",
					colClocks: {},
				});

				expect(await adapter.getOplogHead(["posts"])).toBe(
					"0000000000003000000.0000.server:1",
				);
				expect(await adapter.getOplogHead(["comments"])).toBeNull();
			});

			test("deleteOpsBefore removes old entries", async () => {
				await adapter.appendOp({
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: null,
					hlc: "0000000000001000000.0000.server:1",
					colClocks: {},
				});

				await adapter.appendOp({
					table: "posts",
					op: "insert",
					rowId: "r2",
					payload: null,
					hlc: "0000000000003000000.0000.server:1",
					colClocks: {},
				});

				const deleted = await adapter.deleteOpsBefore("0000000000002000000.0000.server:1");
				expect(deleted).toBe(1);

				const remaining = await adapter.getOpsSince("0000000000000000000.0000.server:0", ["posts"]);
				expect(remaining.length).toBe(1);
				expect(remaining[0]!.rowId).toBe("r2");
			});

			describe("tryLock / unlock (optional)", () => {
			test("tryLock returns true on first acquire, false on contention", async () => {
				if (!adapter.tryLock || !adapter.unlock) return;
				const a = await adapter.tryLock("compaction");
				const b = await adapter.tryLock("compaction");
				expect(a).toBe(true);
				expect(b).toBe(false);
				await adapter.unlock("compaction");
				const c = await adapter.tryLock("compaction");
				expect(c).toBe(true);
				await adapter.unlock("compaction");
			});

			test("different keys do not contend", async () => {
				if (!adapter.tryLock || !adapter.unlock) return;
				expect(await adapter.tryLock("compaction")).toBe(true);
				expect(await adapter.tryLock("other")).toBe(true);
				await adapter.unlock("compaction");
				await adapter.unlock("other");
			});
		});

		test("appendOp handles null payload", async () => {
				await adapter.appendOp({
					table: "posts",
					op: "delete",
					rowId: "r1",
					payload: null,
					hlc: "0000000000001000000.0000.server:1",
					colClocks: {},
				});

				const ops = await adapter.getOpsSince("0000000000000000000.0000.server:0", ["posts"]);

				expect(ops[0]!.payload).toBeNull();
			});
		});
	});
}
