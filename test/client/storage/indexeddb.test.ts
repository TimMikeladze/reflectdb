import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { createIndexedDBStorage } from "../../../src/client/storage/indexeddb.ts";
import { runClientStorageSuite } from "./client-storage-suite.ts";

let dbCounter = 0;
runClientStorageSuite("IndexedDB", () => {
	dbCounter++;
	return createIndexedDBStorage({ dbName: `test-db-${dbCounter}` });
});

describe("IndexedDB appSchemaVersion", () => {
	test("first open persists version, no callback", async () => {
		dbCounter++;
		const dbName = `schema-${dbCounter}`;
		let called = false;
		const s = createIndexedDBStorage({
			dbName,
			appSchemaVersion: 1,
			onSchemaChange: () => {
				called = true;
			},
		});
		await s.getAllRows();
		expect(called).toBe(false);
		expect(await s.getMeta("__reflectdb_appSchemaVersion")).toBe("1");
	});

	test("version mismatch invokes onSchemaChange", async () => {
		dbCounter++;
		const dbName = `schema-${dbCounter}`;
		// Seed v1
		const v1 = createIndexedDBStorage({ dbName, appSchemaVersion: 1 });
		await v1.getAllRows();
		await v1.putRow("posts", "r1", {
			table: "posts",
			rowId: "r1",
			data: { title: "old" },
			colClocks: {},
			serverHlc: null,
		});

		// Reopen with v2
		let captured: { storedVersion: number; configVersion: number } | null = null;
		const v2 = createIndexedDBStorage({
			dbName,
			appSchemaVersion: 2,
			onSchemaChange: async (ctx, storage) => {
				captured = ctx;
				await storage.clear();
			},
		});
		await v2.getAllRows();
		expect(captured).toEqual({ storedVersion: 1, configVersion: 2 });
		expect((await v2.getAllRows()).length).toBe(0);
		expect(await v2.getMeta("__reflectdb_appSchemaVersion")).toBe("2");
	});

	test("IDB version bump invokes migrate callback", async () => {
		dbCounter++;
		const dbName = `migrate-${dbCounter}`;

		// Seed at version 1 directly via raw IDB so we can close the connection.
		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.open(dbName, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				db.createObjectStore("rows", { keyPath: ["table", "rowId"] }).createIndex(
					"table",
					"table",
					{ unique: false },
				);
				db.createObjectStore("pendingOps", { keyPath: "op.id" });
				db.createObjectStore("meta", { keyPath: "key" });
			};
			req.onsuccess = () => {
				req.result.close();
				resolve();
			};
			req.onerror = () => reject(req.error);
		});

		// Reopen at version 2 via adapter with migrate hook.
		const calls: { oldVersion: number; newVersion: number }[] = [];
		const v2 = createIndexedDBStorage({
			dbName,
			version: 2,
			migrate: (ctx) => {
				calls.push({ oldVersion: ctx.oldVersion, newVersion: ctx.newVersion });
				if (!ctx.db.objectStoreNames.contains("custom")) {
					ctx.db.createObjectStore("custom", { keyPath: "id" });
				}
			},
		});
		await v2.getAllRows();
		expect(calls.length).toBe(1);
		expect(calls[0]!.oldVersion).toBe(1);
		expect(calls[0]!.newVersion).toBe(2);
	});

	test("matching version is a no-op", async () => {
		dbCounter++;
		const dbName = `schema-${dbCounter}`;
		const a = createIndexedDBStorage({ dbName, appSchemaVersion: 5 });
		await a.getAllRows();

		let called = false;
		const b = createIndexedDBStorage({
			dbName,
			appSchemaVersion: 5,
			onSchemaChange: () => {
				called = true;
			},
		});
		await b.getAllRows();
		expect(called).toBe(false);
	});
});
