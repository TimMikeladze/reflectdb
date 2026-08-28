import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemDriver } from "../../../../src/server/storage/object/drivers/filesystem.ts";
import { runObjectDriverSuite } from "./driver-suite.ts";

// The driver reaches node:fs through `nodeRequire` because `src/` builds with a
// browser target; a test file has no such constraint and imports it directly.

const roots: string[] = [];

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "reflectdb-objstore-"));
	roots.push(root);
	return root;
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

runObjectDriverSuite("filesystem", () => createFilesystemDriver(freshRoot()));

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("filesystem driver: key safety", () => {
	test("rejects keys that escape the root", async () => {
		const driver = createFilesystemDriver(freshRoot());
		for (const key of ["../outside", "a/../../outside", "/absolute", "a/../../../etc/passwd"]) {
			await expect(driver.put(key, utf8("x"))).rejects.toThrow();
			await expect(driver.get(key)).rejects.toThrow();
		}
	});

	test("rejects any '..' segment, even one that would stay inside the root", async () => {
		// Not normalized to `a/c`, because an S3 key is an opaque byte string in
		// which `a/b/../c` and `a/c` are two different objects. A driver that
		// silently normalized would map two distinct keys onto one file. Since a
		// filesystem cannot represent a literal `..` segment either, refusing is
		// the only honest answer.
		const driver = createFilesystemDriver(freshRoot());
		await expect(driver.put("a/b/../c", utf8("v"))).rejects.toThrow("..");
	});

	test("rejects a key whose prefix already exists as an object", async () => {
		// The one place a filesystem genuinely cannot match an object store: `a`
		// and `a/b` may both exist in S3, but `a` is either a file or a directory
		// here. Named error rather than a bare EEXIST from mkdir.
		const driver = createFilesystemDriver(freshRoot());
		await driver.put("a", utf8("1"));
		await expect(driver.put("a/b", utf8("2"))).rejects.toThrow(
			"a prefix of that key already exists as an object",
		);
		// The existing object is untouched.
		expect(new TextDecoder().decode((await driver.get("a"))!.body)).toBe("1");
	});
});

describe("filesystem driver: durability details", () => {
	test("in-flight temp files never appear in a listing", async () => {
		const root = freshRoot();
		const driver = createFilesystemDriver(root);
		await driver.put("wal/1-1.jsonl", utf8("a"));
		// Simulate a crash that left a temp file behind mid-rename.
		writeFileSync(join(root, "wal", ".reflectdb-tmp-orphan"), "partial");

		expect((await driver.list("wal/")).map((e) => e.key)).toEqual(["wal/1-1.jsonl"]);
	});

	test("etags are derived from content, not mtime", async () => {
		// Two writes inside the same millisecond must still produce different
		// etags, or a CAS that should fail would quietly succeed.
		const driver = createFilesystemDriver(freshRoot());
		const a = await driver.put("k", utf8("v1"));
		const b = await driver.put("k", utf8("v2"));
		expect(a).not.toBe(b);
	});

	test("a driver reopened on the same root sees the same etags", async () => {
		// Etags survive a process restart, which is what makes a manifest etag
		// cached in memory usable after a reboot.
		const root = freshRoot();
		const first = createFilesystemDriver(root);
		const etag = await first.put("_manifest", utf8("gen0"));

		const second = createFilesystemDriver(root);
		expect((await second.get("_manifest"))!.etag).toBe(etag);
		await second.put("_manifest", utf8("gen1"), { ifMatch: etag });
	});

	test("reports wildcard CAS support", () => {
		expect(createFilesystemDriver(freshRoot()).caps.casWildcard).toBe(true);
	});
});
