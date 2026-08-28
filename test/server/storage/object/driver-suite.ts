import { beforeEach, describe, expect, test } from "bun:test";
import type { ObjectDriver } from "../../../../src/server/storage/object/types.ts";
import { PreconditionFailedError } from "../../../../src/server/storage/object/types.ts";

/**
 * Shared conformance suite for any `ObjectDriver`.
 *
 * The whole object-storage design rests on the driver's CAS semantics being
 * identical everywhere: the manifest is the linearization point, and a driver
 * that returns success where S3 would return 412 turns a lost race into silent
 * divergence. So the memory driver, the filesystem driver and a real bucket all
 * run exactly these assertions.
 *
 * Deliberately NOT asserted here: what happens when a key is overwritten with
 * byte-identical content. The memory driver mints a fresh etag per write, while
 * the filesystem driver and real S3 derive the etag from content and leave it
 * unchanged. That divergence is why `ManifestRecord.commitSeq` exists — the
 * manifest never writes identical bytes twice, so callers never depend on
 * either behavior.
 */
export function runObjectDriverSuite(name: string, createDriver: () => ObjectDriver) {
	describe(`ObjectDriver: ${name}`, () => {
		let driver: ObjectDriver;
		const utf8 = (s: string) => new TextEncoder().encode(s);
		const text = (b: Uint8Array) => new TextDecoder().decode(b);

		beforeEach(() => {
			driver = createDriver();
		});

		// ── basic read/write ──────────────────────────────────────────────

		test("get returns null for an absent key", async () => {
			expect(await driver.get("nope")).toBeNull();
		});

		test("put then get round-trips the bytes", async () => {
			await driver.put("a/b/c.json", utf8("hello"));
			const got = await driver.get("a/b/c.json");
			expect(got).not.toBeNull();
			expect(text(got!.body)).toBe("hello");
			expect(typeof got!.etag).toBe("string");
			expect(got!.etag.length).toBeGreaterThan(0);
		});

		test("put returns the same etag a subsequent get reports", async () => {
			const etag = await driver.put("k", utf8("v"));
			expect((await driver.get("k"))!.etag).toBe(etag);
		});

		test("writing different content changes the etag", async () => {
			const first = await driver.put("k", utf8("v1"));
			const second = await driver.put("k", utf8("v2"));
			expect(second).not.toBe(first);
			expect(text((await driver.get("k"))!.body)).toBe("v2");
		});

		test("round-trips arbitrary binary, not just UTF-8", async () => {
			const bytes = new Uint8Array([0, 1, 254, 255, 128, 10, 13]);
			await driver.put("bin", bytes);
			expect([...(await driver.get("bin"))!.body]).toEqual([...bytes]);
		});

		test("stored bytes are isolated from the caller's buffer", async () => {
			// A caller that reuses its encode buffer for the next WAL batch must not
			// be able to mutate what the store already accepted.
			const body = utf8("original");
			await driver.put("k", body);
			body.fill(0);
			expect(text((await driver.get("k"))!.body)).toBe("original");

			const readBack = (await driver.get("k"))!.body;
			readBack.fill(0);
			expect(text((await driver.get("k"))!.body)).toBe("original");
		});

		// ── conditional writes: create-if-absent ──────────────────────────

		test("ifNoneMatch '*' succeeds when the key is absent", async () => {
			if (!driver.caps.casWildcard) return;
			await driver.put("fresh", utf8("v"), { ifNoneMatch: "*" });
			expect(text((await driver.get("fresh"))!.body)).toBe("v");
		});

		test("ifNoneMatch '*' throws PreconditionFailedError when the key exists", async () => {
			if (!driver.caps.casWildcard) return;
			await driver.put("taken", utf8("first"));
			await expect(
				driver.put("taken", utf8("second"), { ifNoneMatch: "*" }),
			).rejects.toBeInstanceOf(PreconditionFailedError);
			// The loser must not have overwritten the winner.
			expect(text((await driver.get("taken"))!.body)).toBe("first");
		});

		// ── conditional writes: compare-and-swap ──────────────────────────

		test("ifMatch succeeds when the etag matches", async () => {
			const etag = await driver.put("k", utf8("v1"));
			await driver.put("k", utf8("v2"), { ifMatch: etag });
			expect(text((await driver.get("k"))!.body)).toBe("v2");
		});

		test("ifMatch throws PreconditionFailedError on a stale etag", async () => {
			const stale = await driver.put("k", utf8("v1"));
			await driver.put("k", utf8("v2"));
			await expect(driver.put("k", utf8("v3"), { ifMatch: stale })).rejects.toBeInstanceOf(
				PreconditionFailedError,
			);
			expect(text((await driver.get("k"))!.body)).toBe("v2");
		});

		test("ifMatch against an absent key is a precondition failure, never a create", async () => {
			await expect(
				driver.put("missing", utf8("v"), { ifMatch: '"whatever"' }),
			).rejects.toBeInstanceOf(PreconditionFailedError);
			expect(await driver.get("missing")).toBeNull();
		});

		test("only one of two racing CAS writers wins", async () => {
			// The election primitive, in miniature: both read the same etag, both
			// try to advance it, exactly one succeeds.
			const etag = await driver.put("_manifest", utf8("gen0"));
			const results = await Promise.allSettled([
				driver.put("_manifest", utf8("gen1-A"), { ifMatch: etag }),
				driver.put("_manifest", utf8("gen1-B"), { ifMatch: etag }),
			]);
			const fulfilled = results.filter((r) => r.status === "fulfilled");
			const rejected = results.filter((r) => r.status === "rejected");
			expect(fulfilled.length).toBe(1);
			expect(rejected.length).toBe(1);
			expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
				PreconditionFailedError,
			);
		});

		test("passing both ifMatch and ifNoneMatch is a caller bug, not a 412", async () => {
			// Surfacing this as a precondition failure would send the caller into a
			// re-read-and-retry loop that can never succeed.
			const error = await driver
				.put("k", utf8("v"), { ifMatch: '"a"', ifNoneMatch: "*" })
				.then(
					() => null,
					(e: unknown) => e,
				);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(PreconditionFailedError);
		});

		// ── list ──────────────────────────────────────────────────────────

		test("list filters by prefix and returns store-relative keys", async () => {
			await driver.put("rooms/r1/wal/1-1.jsonl", utf8("a"));
			await driver.put("rooms/r1/wal/1-2.jsonl", utf8("bb"));
			await driver.put("rooms/r2/wal/1-1.jsonl", utf8("ccc"));

			const listed = await driver.list("rooms/r1/wal/");
			expect(listed.map((e) => e.key)).toEqual([
				"rooms/r1/wal/1-1.jsonl",
				"rooms/r1/wal/1-2.jsonl",
			]);
			expect(listed.map((e) => e.size)).toEqual([1, 2]);
		});

		test("list returns keys in ascending byte order", async () => {
			// WAL replay applies segments in listing order, so ordering is
			// correctness rather than tidiness.
			for (const key of ["wal/1-9", "wal/1-10", "wal/1-1", "wal/2-1"]) {
				await driver.put(key, utf8("x"));
			}
			expect((await driver.list("wal/")).map((e) => e.key)).toEqual([
				"wal/1-1",
				"wal/1-10",
				"wal/1-9",
				"wal/2-1",
			]);
		});

		test("list returns an empty array for a prefix with nothing under it", async () => {
			expect(await driver.list("nothing/")).toEqual([]);
		});

		test("an empty prefix lists everything", async () => {
			await driver.put("a", utf8("x"));
			await driver.put("b/c", utf8("y"));
			expect((await driver.list("")).map((e) => e.key)).toEqual(["a", "b/c"]);
		});

		// ── delete ────────────────────────────────────────────────────────

		test("delete removes the named keys and leaves the rest", async () => {
			await driver.put("keep", utf8("k"));
			await driver.put("drop1", utf8("d"));
			await driver.put("drop2", utf8("d"));

			await driver.delete(["drop1", "drop2"]);
			expect(await driver.get("drop1")).toBeNull();
			expect(await driver.get("drop2")).toBeNull();
			expect(await driver.get("keep")).not.toBeNull();
		});

		test("deleting an absent key is not an error", async () => {
			await driver.delete(["never-existed"]);
			await driver.delete([]);
		});

		test("a deleted key can be recreated with ifNoneMatch", async () => {
			if (!driver.caps.casWildcard) return;
			await driver.put("k", utf8("v1"));
			await driver.delete(["k"]);
			await driver.put("k", utf8("v2"), { ifNoneMatch: "*" });
			expect(text((await driver.get("k"))!.body)).toBe("v2");
		});

		// ── keys ──────────────────────────────────────────────────────────

		test("keys at different depths stay distinct", async () => {
			// Deliberately no key that is also a prefix of another (`a` alongside
			// `a/b`). Object stores allow that pair; a filesystem cannot represent
			// it, so the filesystem driver rejects the collision with a named error
			// — see its own test file. reflectdb's layout never produces the pair,
			// so the suite stays to the semantics all three drivers share.
			await driver.put("a/x", utf8("1"));
			await driver.put("a/b/x", utf8("2"));
			await driver.put("a/b/c/x", utf8("3"));
			expect(text((await driver.get("a/x"))!.body)).toBe("1");
			expect(text((await driver.get("a/b/x"))!.body)).toBe("2");
			expect(text((await driver.get("a/b/c/x"))!.body)).toBe("3");
		});

		test("caps reports whether wildcard CAS is available", () => {
			expect(typeof driver.caps.casWildcard).toBe("boolean");
		});
	});
}
