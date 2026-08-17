import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { defineSyncQueries } from "../../src/core/schema.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import type { ServerTransport } from "../../src/core/types.ts";

// ── Schema ──────────────────────────────────────────────────────────────

const items = sqliteTable("items", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	status: text("status").notNull().default("active"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

const queries = defineSyncQueries({
	items: {
		table: items,
		conflict: "lww",
		readonly: ["status"],
		serverSet: ["createdAt"],
	},
});

// ── Helpers ─────────────────────────────────────────────────────────────

function setup() {
	const sqlite = new Database(":memory:");
	sqlite.run(`CREATE TABLE items (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'active',
		created_at INTEGER NOT NULL
	)`);
	const db = drizzle(sqlite);

	// Dummy transport (REST doesn't use it)
	const transport: ServerTransport = {
		async send() {},
		async broadcast() {},
		onMessage() {},
		onConnect() {},
		onDisconnect() {},
		async close() {},
	};

	const server = createSyncServer<typeof queries, typeof db>({
		queries,
		db,
		transport,
		serverId: "rest-test",
	});

	server.auth(async (req) => {
		const token = req.headers.get("authorization")?.slice(7);
		if (token === "bad") throw new Error("invalid token");
		return { userId: token ?? "anon" };
	});

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
		serverSet: { createdAt: () => new Date(1000) },
	});

	const rest = server.rest({ prefix: "/api" });
	return { rest, db, sqlite };
}

function req(method: string, path: string, body?: unknown, token = "user1"): Request {
	return new Request(`http://localhost${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("REST handler", () => {
	test("GET /api lists available queries", async () => {
		const { rest } = setup();
		const res = await rest(req("GET", "/api"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.queries).toEqual(["items"]);
	});

	test("GET /api/items returns empty array", async () => {
		const { rest } = setup();
		const res = await rest(req("GET", "/api/items"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("POST /api/items creates a row", async () => {
		const { rest } = setup();
		const res = await rest(req("POST", "/api/items", { id: "i-1", name: "Test" }));
		expect(res.status).toBe(201);
		const data = await res.json();
		expect(data.id).toBe("i-1");

		const list = await (await rest(req("GET", "/api/items"))).json();
		expect(list.length).toBe(1);
		expect(list[0].name).toBe("Test");
	});

	test("POST auto-generates id when not provided", async () => {
		const { rest } = setup();
		const res = await rest(req("POST", "/api/items", { name: "Auto ID" }));
		const data = await res.json();
		expect(data.id).toBeDefined();
		expect(data.id.length).toBeGreaterThan(0);
	});

	test("serverSet fields are applied on insert", async () => {
		const { rest } = setup();
		await rest(req("POST", "/api/items", { id: "i-1", name: "Test" }));

		const list = await (await rest(req("GET", "/api/items"))).json();
		expect(list[0].createdAt).toEqual(new Date(1000).toISOString());
	});

	test("GET /api/items/:id returns single row", async () => {
		const { rest } = setup();
		await rest(req("POST", "/api/items", { id: "i-1", name: "Found" }));

		const res = await rest(req("GET", "/api/items/i-1"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.name).toBe("Found");
	});

	test("GET /api/items/:id returns 404 for missing row", async () => {
		const { rest } = setup();
		const res = await rest(req("GET", "/api/items/nope"));
		expect(res.status).toBe(404);
	});

	test("PATCH /api/items/:id updates a row", async () => {
		const { rest } = setup();
		await rest(req("POST", "/api/items", { id: "i-1", name: "Before" }));

		const res = await rest(req("PATCH", "/api/items/i-1", { name: "After" }));
		expect(res.status).toBe(200);

		const row = await (await rest(req("GET", "/api/items/i-1"))).json();
		expect(row.name).toBe("After");
	});

	test("DELETE /api/items/:id removes a row", async () => {
		const { rest } = setup();
		await rest(req("POST", "/api/items", { id: "i-1", name: "Bye" }));

		const res = await rest(req("DELETE", "/api/items/i-1"));
		expect(res.status).toBe(200);

		const list = await (await rest(req("GET", "/api/items"))).json();
		expect(list.length).toBe(0);
	});

	test("unknown query returns 404", async () => {
		const { rest } = setup();
		const res = await rest(req("GET", "/api/nope"));
		expect(res.status).toBe(404);
	});

	test("auth failure returns 401", async () => {
		const { rest } = setup();
		const res = await rest(req("GET", "/api/items", undefined, "bad"));
		expect(res.status).toBe(401);
	});

	test("PATCH without id returns 400", async () => {
		const { rest } = setup();
		const res = await rest(req("PATCH", "/api/items", { name: "x" }));
		expect(res.status).toBe(400);
	});

	test("DELETE without id returns 400", async () => {
		const { rest } = setup();
		const res = await rest(req("DELETE", "/api/items"));
		expect(res.status).toBe(400);
	});

	test("readonly fields are stripped from POST payload", async () => {
		const { rest } = setup();
		// status is readonly — should be stripped, falling back to DB default
		await rest(req("POST", "/api/items", { id: "i-1", name: "Test", status: "hacked" }));

		const row = await (await rest(req("GET", "/api/items/i-1"))).json();
		expect(row.status).toBe("active"); // DB default, not "hacked"
	});

	test("readonly fields are stripped from PATCH payload", async () => {
		const { rest } = setup();
		await rest(req("POST", "/api/items", { id: "i-1", name: "Test" }));

		await rest(req("PATCH", "/api/items/i-1", { name: "Updated", status: "hacked" }));

		const row = await (await rest(req("GET", "/api/items/i-1"))).json();
		expect(row.name).toBe("Updated");
		expect(row.status).toBe("active"); // unchanged
	});

	test("notifyChange is called after write", async () => {
		const { rest } = setup();
		// notifyChange calls broadcastChanges on the handler.
		// With no connected sync clients this is a no-op, but we verify
		// it doesn't throw and the write still succeeds.
		const res = await rest(req("POST", "/api/items", { id: "i-1", name: "Broadcast" }));
		expect(res.status).toBe(201);

		const row = await (await rest(req("GET", "/api/items/i-1"))).json();
		expect(row.name).toBe("Broadcast");
	});
});

// ── Object-form serverSet (schema-collocated values) ─────────────────────

function setupObjectForm(implOverride?: { createdAt: () => Date }) {
	const sqlite = new Database(":memory:");
	sqlite.run(`CREATE TABLE items (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'active',
		created_at INTEGER NOT NULL
	)`);
	const db = drizzle(sqlite);

	const transport: ServerTransport = {
		async send() {},
		async broadcast() {},
		onMessage() {},
		onConnect() {},
		onDisconnect() {},
		async close() {},
	};

	const objQueries = defineSyncQueries({
		items: {
			table: items,
			conflict: "lww",
			readonly: ["status"],
			// Object form: value lives in schema, no array.
			serverSet: { createdAt: () => new Date(5000) },
		},
	});

	const server = createSyncServer<typeof objQueries, typeof db>({
		queries: objQueries,
		db,
		transport,
		serverId: "rest-test-objform",
	});

	server.auth(async () => ({ userId: "anon" }));

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
		// implement.serverSet is OPTIONAL with schema object form
		...(implOverride ? { serverSet: implOverride } : {}),
	});

	return { rest: server.rest({ prefix: "/api" }) };
}

describe("REST handler — object-form serverSet", () => {
	test("schema object-form serverSet stamps the value on insert (no impl override)", async () => {
		const { rest } = setupObjectForm();
		await rest(req("POST", "/api/items", { id: "o-1", name: "FromSchema" }));

		const row = await (await rest(req("GET", "/api/items/o-1"))).json();
		// Value provided by schema's object form (Date(5000))
		expect(row.createdAt).toEqual(new Date(5000).toISOString());
	});

	test("impl.serverSet override wins over schema value", async () => {
		// Use whole-second values — drizzle's `mode: "timestamp"` truncates to seconds.
		const { rest } = setupObjectForm({ createdAt: () => new Date(9000) });
		await rest(req("POST", "/api/items", { id: "o-2", name: "Overridden" }));

		const row = await (await rest(req("GET", "/api/items/o-2"))).json();
		// impl override wins (9000 != schema's 5000)
		expect(row.createdAt).toEqual(new Date(9000).toISOString());
	});
});
