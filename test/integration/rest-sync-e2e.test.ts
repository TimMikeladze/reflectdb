import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineSyncQueries } from "../../src/core/schema.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import { createSqliteStorage } from "../../src/server/storage/sqlite.ts";
import { createWsServerTransport } from "../../src/transport/ws.ts";
import type { WebSocketLike } from "../../src/transport/ws.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type { ServerMessage } from "../../src/core/types.ts";

// ── Schema ──────────────────────────────────────────────────────────────

const items = sqliteTable("items", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
});

const queries = defineSyncQueries({
	items: { table: items, conflict: "lww" },
});

// ── Helpers ─────────────────────────────────────────────────────────────

function setup() {
	const sqlite = new Database(":memory:");
	sqlite.run("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
	const db = drizzle(sqlite);
	const storage = createSqliteStorage({ db: sqlite });
	const wsTransport = createWsServerTransport();

	const server = createSyncServer<typeof queries, typeof db>({
		queries,
		db,
		transport: wsTransport,
		storage,
		serverId: "rest-sync-e2e",
	});

	server.auth(async () => ({ userId: "demo" }));

	server.implement("items", {
		query: (_ctx, db) => db.select().from(items),
		mutate: async (op, _ctx, db) => {
			if (op.type === "delete") {
				await db.delete(items).where(eq(items.id, op.rowId));
			} else if (op.type === "insert") {
				await db
					.insert(items)
					.values({ id: op.rowId, ...op.payload } as typeof items.$inferInsert)
					.onConflictDoUpdate({ target: items.id, set: op.payload as Record<string, unknown> });
			} else {
				await db
					.update(items)
					.set(op.payload as Record<string, unknown>)
					.where(eq(items.id, op.rowId));
			}
		},
	});

	const rest = server.rest({ prefix: "/api" });

	return { rest, wsTransport, server };
}

function restReq(method: string, path: string, body?: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}

function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("REST → sync delta broadcasting", () => {
	test("REST POST triggers delta to connected sync client", async () => {
		const { rest, wsTransport } = setup();

		// Connect a sync client via WS
		const received: ServerMessage[] = [];
		const ws: WebSocketLike = {
			send(data) {
				received.push(JSON.parse(data));
			},
			close() {},
		};
		wsTransport.handleOpen("syncClient", ws);

		// Hello
		wsTransport.handleMessage(
			"syncClient",
			JSON.stringify({
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				clientId: "syncClient",
				token: "valid",
			}),
		);
		await tick();

		// Subscribe to items
		wsTransport.handleMessage(
			"syncClient",
			JSON.stringify({
				type: "sync_declare",
				table: "items",
			}),
		);
		await tick();

		// Bootstrap (empty)
		wsTransport.handleMessage("syncClient", JSON.stringify({ type: "bootstrap" }));
		await tick();

		// Clear received messages
		received.length = 0;

		// REST POST — should trigger delta to sync client
		const res = await rest(restReq("POST", "/api/items", { id: "r-1", name: "from REST" }));
		expect(res.status).toBe(201);
		await tick();

		// Sync client should have received a delta
		const delta = received.find((m) => m.type === "delta");
		expect(delta).toBeDefined();
		expect((delta as { rowId: string }).rowId).toBe("r-1");
		expect((delta as { payload: { name: string } }).payload.name).toBe("from REST");
	});

	test("REST PATCH triggers delta to connected sync client", async () => {
		const { rest, wsTransport } = setup();

		// Seed a row via REST
		await rest(restReq("POST", "/api/items", { id: "r-1", name: "original" }));

		// Connect sync client
		const received: ServerMessage[] = [];
		const ws: WebSocketLike = {
			send(data) {
				received.push(JSON.parse(data));
			},
			close() {},
		};
		wsTransport.handleOpen("syncClient", ws);

		wsTransport.handleMessage(
			"syncClient",
			JSON.stringify({
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				clientId: "syncClient",
				token: "valid",
			}),
		);
		await tick();

		wsTransport.handleMessage(
			"syncClient",
			JSON.stringify({
				type: "sync_declare",
				table: "items",
			}),
		);
		await tick();

		wsTransport.handleMessage("syncClient", JSON.stringify({ type: "bootstrap" }));
		await tick();
		received.length = 0;

		// REST PATCH
		await rest(restReq("PATCH", "/api/items/r-1", { name: "updated via REST" }));
		await tick();

		const delta = received.find((m) => m.type === "delta");
		expect(delta).toBeDefined();
		expect((delta as { payload: { name: string } }).payload.name).toBe("updated via REST");
	});

	test("REST DELETE triggers delta to connected sync client", async () => {
		const { rest, wsTransport } = setup();

		// Seed
		await rest(restReq("POST", "/api/items", { id: "r-1", name: "doomed" }));

		// Connect sync client
		const received: ServerMessage[] = [];
		const ws: WebSocketLike = {
			send(data) {
				received.push(JSON.parse(data));
			},
			close() {},
		};
		wsTransport.handleOpen("syncClient", ws);

		wsTransport.handleMessage(
			"syncClient",
			JSON.stringify({
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				clientId: "syncClient",
				token: "valid",
			}),
		);
		await tick();

		wsTransport.handleMessage(
			"syncClient",
			JSON.stringify({
				type: "sync_declare",
				table: "items",
			}),
		);
		await tick();

		wsTransport.handleMessage("syncClient", JSON.stringify({ type: "bootstrap" }));
		await tick();
		received.length = 0;

		// REST DELETE
		await rest(restReq("DELETE", "/api/items/r-1"));
		await tick();

		const delta = received.find((m) => m.type === "delta");
		expect(delta).toBeDefined();
		expect((delta as { type: string; op: string }).op).toBe("delete");
		expect((delta as { rowId: string }).rowId).toBe("r-1");
	});

	test("batch POST creates multiple rows and triggers single broadcast", async () => {
		const { rest } = setup();

		const res = await rest(
			restReq("POST", "/api/items", [
				{ id: "b-1", name: "First" },
				{ id: "b-2", name: "Second" },
				{ id: "b-3", name: "Third" },
			]),
		);
		expect(res.status).toBe(201);
		const data = await res.json();
		expect(data.ids).toEqual(["b-1", "b-2", "b-3"]);

		// Verify all rows exist
		const list = await (await rest(restReq("GET", "/api/items"))).json();
		expect(list.length).toBe(3);
	});

	test("batch POST auto-generates ids when not provided", async () => {
		const { rest } = setup();

		const res = await rest(
			restReq("POST", "/api/items", [{ name: "No ID 1" }, { name: "No ID 2" }]),
		);
		const data = await res.json();
		expect(data.ids.length).toBe(2);
		expect(data.ids[0]).not.toBe(data.ids[1]);
	});
});
