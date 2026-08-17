import { describe, expect, test } from "bun:test";
import { ResultCache } from "../../src/server/result-cache.ts";

describe("ResultCache", () => {
	test("empty cache returns all rows as inserted", () => {
		const cache = new ResultCache();
		const diff = cache.set("client-1", "posts", [
			{ id: "r1", title: "Hello" },
			{ id: "r2", title: "World" },
		]);

		expect(diff.inserted.length).toBe(2);
		expect(diff.updated.length).toBe(0);
		expect(diff.deleted.length).toBe(0);
		expect(diff.inserted[0]!.rowId).toBe("r1");
		expect(diff.inserted[1]!.rowId).toBe("r2");
	});

	test("same rows returns no changes", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", title: "Hello" }]);
		const diff = cache.set("client-1", "posts", [{ id: "r1", title: "Hello" }]);

		expect(diff.inserted.length).toBe(0);
		expect(diff.updated.length).toBe(0);
		expect(diff.deleted.length).toBe(0);
	});

	test("detects updated fields", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", title: "Old", body: "keep" }]);
		const diff = cache.set("client-1", "posts", [{ id: "r1", title: "New", body: "keep" }]);

		expect(diff.inserted.length).toBe(0);
		expect(diff.updated.length).toBe(1);
		expect(diff.updated[0]!.rowId).toBe("r1");
		expect(diff.updated[0]!.changed).toEqual({ title: "New" });
		expect(diff.deleted.length).toBe(0);
	});

	test("detects deleted rows", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [
			{ id: "r1", title: "Hello" },
			{ id: "r2", title: "World" },
		]);
		const diff = cache.set("client-1", "posts", [{ id: "r1", title: "Hello" }]);

		expect(diff.inserted.length).toBe(0);
		expect(diff.updated.length).toBe(0);
		expect(diff.deleted.length).toBe(1);
		expect(diff.deleted[0]).toBe("r2");
	});

	test("detects mixed insert, update, delete", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [
			{ id: "r1", title: "Keep" },
			{ id: "r2", title: "Update me" },
			{ id: "r3", title: "Delete me" },
		]);
		const diff = cache.set("client-1", "posts", [
			{ id: "r1", title: "Keep" },
			{ id: "r2", title: "Updated" },
			{ id: "r4", title: "New row" },
		]);

		expect(diff.inserted.length).toBe(1);
		expect(diff.inserted[0]!.rowId).toBe("r4");
		expect(diff.updated.length).toBe(1);
		expect(diff.updated[0]!.rowId).toBe("r2");
		expect(diff.updated[0]!.changed).toEqual({ title: "Updated" });
		expect(diff.deleted.length).toBe(1);
		expect(diff.deleted[0]).toBe("r3");
	});

	test("get returns cached rows", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", title: "Hello" }]);

		const cached = cache.get("client-1", "posts");
		expect(cached.size).toBe(1);
		expect(cached.get("r1")).toEqual({ id: "r1", title: "Hello" });
	});

	test("get returns empty map for unknown client/query", () => {
		const cache = new ResultCache();
		expect(cache.get("unknown", "posts").size).toBe(0);
	});

	test("clear removes specific query cache", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", title: "Hello" }]);
		cache.set("client-1", "users", [{ id: "u1", name: "Alice" }]);

		cache.clear("client-1", "posts");
		expect(cache.get("client-1", "posts").size).toBe(0);
		expect(cache.get("client-1", "users").size).toBe(1);
	});

	test("clearClient removes all caches for a client", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", title: "Hello" }]);
		cache.set("client-1", "users", [{ id: "u1", name: "Alice" }]);

		cache.clearClient("client-1");
		expect(cache.get("client-1", "posts").size).toBe(0);
		expect(cache.get("client-1", "users").size).toBe(0);
	});

	test("separate clients have independent caches", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", title: "A" }]);
		cache.set("client-2", "posts", [{ id: "r1", title: "B" }]);

		const c1 = cache.get("client-1", "posts");
		const c2 = cache.get("client-2", "posts");
		expect(c1.get("r1")).toEqual({ id: "r1", title: "A" });
		expect(c2.get("r1")).toEqual({ id: "r1", title: "B" });
	});

	test("detects removed fields as null", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", title: "Hello", body: "content" }]);
		const diff = cache.set("client-1", "posts", [{ id: "r1", title: "Hello" }]);

		expect(diff.updated.length).toBe(1);
		expect(diff.updated[0]!.changed).toEqual({ body: null });
	});

	test("does not report false changes for identical object values", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", tags: ["a", "b"], meta: { views: 10 } }]);
		// Same values, different object references
		const diff = cache.set("client-1", "posts", [
			{ id: "r1", tags: ["a", "b"], meta: { views: 10 } },
		]);

		expect(diff.updated.length).toBe(0);
		expect(diff.inserted.length).toBe(0);
		expect(diff.deleted.length).toBe(0);
	});

	test("detects actual changes in object values", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", tags: ["a", "b"], meta: { views: 10 } }]);
		const diff = cache.set("client-1", "posts", [
			{ id: "r1", tags: ["a", "c"], meta: { views: 10 } },
		]);

		expect(diff.updated.length).toBe(1);
		expect(diff.updated[0]!.changed).toEqual({ tags: ["a", "c"] });
	});

	test("deepEqual handles null values correctly", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", meta: null }]);
		const diff = cache.set("client-1", "posts", [{ id: "r1", meta: null }]);

		expect(diff.updated.length).toBe(0);
	});

	test("deepEqual detects null vs object change", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", meta: null }]);
		const diff = cache.set("client-1", "posts", [{ id: "r1", meta: { key: "val" } }]);

		expect(diff.updated.length).toBe(1);
		expect(diff.updated[0]!.changed).toEqual({ meta: { key: "val" } });
	});

	test("deepEqual handles nested objects", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [
			{ id: "r1", config: { theme: { primary: "#000", secondary: "#fff" }, version: 2 } },
		]);
		// Same nested structure
		const diff1 = cache.set("client-1", "posts", [
			{ id: "r1", config: { theme: { primary: "#000", secondary: "#fff" }, version: 2 } },
		]);
		expect(diff1.updated.length).toBe(0);

		// Deep change
		const diff2 = cache.set("client-1", "posts", [
			{ id: "r1", config: { theme: { primary: "#111", secondary: "#fff" }, version: 2 } },
		]);
		expect(diff2.updated.length).toBe(1);
	});

	test("deepEqual handles arrays of different lengths", () => {
		const cache = new ResultCache();
		cache.set("client-1", "posts", [{ id: "r1", tags: ["a", "b"] }]);
		const diff = cache.set("client-1", "posts", [{ id: "r1", tags: ["a", "b", "c"] }]);

		expect(diff.updated.length).toBe(1);
		expect(diff.updated[0]!.changed).toEqual({ tags: ["a", "b", "c"] });
	});

	test("deepEqual treats different Date values as not-equal", () => {
		const cache = new ResultCache();
		const t1 = new Date("2026-01-01T00:00:00Z");
		const t2 = new Date("2026-01-02T00:00:00Z");
		cache.set("c", "posts", [{ id: "r1", updatedAt: t1 }]);
		const diff = cache.set("c", "posts", [{ id: "r1", updatedAt: t2 }]);
		expect(diff.updated.length).toBe(1);
	});

	test("deepEqual treats equal Date values as equal", () => {
		const cache = new ResultCache();
		cache.set("c", "posts", [{ id: "r1", updatedAt: new Date("2026-01-01T00:00:00Z") }]);
		const diff = cache.set("c", "posts", [
			{ id: "r1", updatedAt: new Date("2026-01-01T00:00:00Z") },
		]);
		expect(diff.updated.length).toBe(0);
	});

	test("detects changes when the query mutates its rows in place", () => {
		// An in-memory store hands the same row objects back on every call. If the
		// cache kept references, the second diff would compare each row with
		// itself and report nothing — the client would stop receiving updates
		// after the first broadcast, with no error anywhere.
		const cache = new ResultCache();
		const live = { id: "r1", x: 0 };

		cache.set("c", "balls", [live]);
		live.x = 5;
		const diff = cache.set("c", "balls", [live]);

		expect(diff.updated.length).toBe(1);
		expect(diff.updated[0]!.changed).toEqual({ x: 5 });
	});

	test("diffOnly sees an in-place mutation against a committed snapshot", () => {
		const cache = new ResultCache();
		const live = { id: "r1", x: 0 };

		cache.set("c", "balls", [live]);
		live.x = 1;

		expect(cache.diffOnly("c", "balls", [live]).updated).toEqual([
			{ rowId: "r1", changed: { x: 1 } },
		]);
		// diffOnly must not commit, so the same mutation still diffs afterwards.
		expect(cache.diffOnly("c", "balls", [live]).updated.length).toBe(1);
	});
});
