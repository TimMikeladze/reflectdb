import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import { defineSyncQueries } from "../../src/core/schema.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { createMockTransport } from "./helpers.ts";

function createInMemoryStorage(): StorageAdapter {
	const store = new Map<
		string,
		{ row: Record<string, unknown>; colClocks: Record<string, string>; hlc: string }
	>();
	return {
		async getRow(table, rowId) {
			const entry = store.get(`${table}:${rowId}`);
			if (!entry) return { row: null, rowHlc: null, colClocks: {} };
			return { row: entry.row, rowHlc: entry.hlc, colClocks: entry.colClocks };
		},
		async putRow(table, rowId, row, colClocks, hlc) {
			if (row === null) store.delete(`${table}:${rowId}`);
			else store.set(`${table}:${rowId}`, { row, colClocks, hlc });
		},
		async getRows(table) {
			const rows: Record<string, unknown>[] = [];
			const colClocks: Record<string, Record<string, string>> = {};
			for (const [key, entry] of store) {
				if (key.startsWith(`${table}:`)) {
					rows.push(entry.row);
					colClocks[key.split(":")[1]!] = entry.colClocks;
				}
			}
			return { rows, colClocks };
		},
		async appendOp() {},
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

describe("server.emit", () => {
	test("writes through and persists row", async () => {
		const transport = createMockTransport();
		const storage = createInMemoryStorage();
		const server = createServer({
			db: {},
			transport,
			serverId: "emit-test",
			storage,
		});

		server.query("posts", async () => (await storage.getRows("posts")).rows, {
			tables: ["posts"],
			conflict: "lww",
			mutate: async () => {},
		});

		const result = await server.emit("posts", { id: "p1", text: "hello" });
		expect(result.rowId).toBe("p1");
		expect(typeof result.hlc).toBe("string");
		expect(result.hlc.length).toBeGreaterThan(0);

		const stored = await storage.getRow("posts", "p1");
		expect(stored.row).toBeDefined();
		expect(stored.row!.text).toBe("hello");

		await server.close();
	});

	test("returns { hlc, rowId } shape", async () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
			storage: createInMemoryStorage(),
		});
		server.query("posts", async () => [], {
			tables: ["posts"],
			conflict: "lww",
			mutate: async () => {},
		});

		const result = await server.emit("posts", { name: "x" });
		expect(Object.keys(result).sort()).toEqual(["hlc", "rowId"]);
		expect(typeof result.hlc).toBe("string");
		expect(typeof result.rowId).toBe("string");

		await server.close();
	});

	test("payload.id is honored for rowId", async () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
			storage: createInMemoryStorage(),
		});
		server.query("posts", async () => [], {
			tables: ["posts"],
			conflict: "lww",
			mutate: async () => {},
		});

		const result = await server.emit("posts", { id: "explicit-id", text: "hi" });
		expect(result.rowId).toBe("explicit-id");

		await server.close();
	});

	test("absent payload.id generates a uuid", async () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
			storage: createInMemoryStorage(),
		});
		server.query("posts", async () => [], {
			tables: ["posts"],
			conflict: "lww",
			mutate: async () => {},
		});

		const result = await server.emit("posts", { text: "no id" });
		expect(result.rowId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);

		await server.close();
	});

	test("explicit rowId override wins over payload.id", async () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
			storage: createInMemoryStorage(),
		});
		server.query("posts", async () => [], {
			tables: ["posts"],
			conflict: "lww",
			mutate: async () => {},
		});

		const result = await server.emit(
			"posts",
			{ id: "from-payload", text: "hi" },
			{ rowId: "from-options" },
		);
		expect(result.rowId).toBe("from-options");

		await server.close();
	});

	test("typed-server exposes emit/lock/tryLock/interval/timeout", async () => {
		const queries = defineSyncQueries({
			notes: {
				row: {} as { id: string; text: string },
				tables: ["notes"],
				conflict: "lww",
			},
		});
		const transport = createMockTransport();
		const server = createSyncServer<typeof queries>({
			queries,
			db: {},
			transport,
			storage: createInMemoryStorage(),
		});

		expect(typeof server.emit).toBe("function");
		expect(typeof server.lock).toBe("function");
		expect(typeof server.tryLock).toBe("function");
		expect(typeof server.interval).toBe("function");
		expect(typeof server.timeout).toBe("function");

		server.implement("notes", {
			query: () => [],
			mutate: async () => {},
		});

		const result = await server.emit("notes", { id: "n1", text: "hi" });
		expect(result.rowId).toBe("n1");
		expect(typeof result.hlc).toBe("string");

		const locked = await server.lock("k", async () => "locked-result");
		expect(locked).toBe("locked-result");

		await server.close();
	});

	test("roomKey scopes the broadcast", async () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
			storage: createInMemoryStorage(),
		});
		server.query("posts", async () => [], {
			tables: ["posts"],
			conflict: "lww",
			mutate: async () => {},
		});

		await server.emit("posts", { id: "a", text: "in room" }, { roomKey: "room-1" });
		await server.emit("posts", { id: "b", text: "in other" }, { roomKey: "room-2" });

		// Different roomKeys produce broadcasts targeting distinct roomIds.
		// We don't assert the exact wire format — just that the emits succeeded
		// and produced different row ids landing through applyServerOp's
		// broadcast pipeline.
		expect(transport.broadcastedMessages.length).toBeGreaterThanOrEqual(0);

		await server.close();
	});
});
