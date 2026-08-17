import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineSyncQueries } from "../../src/core/schema.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import type {
	BootstrapCompleteMessage,
	ServerTransport,
	SnapshotMessage,
} from "../../src/core/types.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import { createMockTransport } from "./helpers.ts";

// ── Schema with non-id primary key ──────────────────────────────────────

const userSettings = sqliteTable("user_settings", {
	userId: text("user_id").primaryKey(),
	theme: text("theme").notNull(),
	locale: text("locale").notNull(),
});

const queries = defineSyncQueries({
	userSettings: {
		table: userSettings,
		pk: "userId",
		conflict: "lww",
	},
});

// ── REST handler setup ──────────────────────────────────────────────────

function setupRest() {
	const sqlite = new Database(":memory:");
	sqlite.run(`CREATE TABLE user_settings (
		user_id TEXT PRIMARY KEY,
		theme TEXT NOT NULL,
		locale TEXT NOT NULL
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

	const server = createSyncServer<typeof queries, typeof db>({
		queries,
		db,
		transport,
		serverId: "pk-test",
	});

	server.auth(async () => ({ userId: "tester" }));

	server.implement("userSettings", {
		query: (_ctx, db) => db.select().from(userSettings),
		mutate: async (op, _ctx, db) => {
			if (op.type === "delete") {
				await db.delete(userSettings).where(eq(userSettings.userId, op.rowId));
			} else if (op.type === "insert") {
				await db
					.insert(userSettings)
					.values({
						userId: op.rowId,
						...(op.payload as { theme: string; locale: string }),
					})
					.onConflictDoUpdate({
						target: userSettings.userId,
						set: op.payload as Record<string, unknown>,
					});
			} else {
				await db
					.update(userSettings)
					.set(op.payload as Record<string, unknown>)
					.where(eq(userSettings.userId, op.rowId));
			}
		},
	});

	return { rest: server.rest({ prefix: "/api" }), db };
}

function req(method: string, path: string, body?: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}

// ── REST tests ──────────────────────────────────────────────────────────

describe("REST handler with non-id primary key", () => {
	test("POST uses pk field from body as rowId", async () => {
		const { rest, db } = setupRest();
		const res = await rest(
			req("POST", "/api/userSettings", { userId: "u-1", theme: "dark", locale: "en-US" }),
		);
		expect(res.status).toBe(201);
		const data = await res.json();
		expect(data.id).toBe("u-1");

		const stored = await db.select().from(userSettings).all();
		expect(stored).toEqual([{ userId: "u-1", theme: "dark", locale: "en-US" }]);
	});

	test("POST strips pk field from stored payload", async () => {
		const { rest, db } = setupRest();
		// If pk weren't stripped, the insert would attempt to write `userId` via the payload spread
		// AND via rowId — not a conflict here, but we verify the row is correctly shaped.
		await rest(
			req("POST", "/api/userSettings", { userId: "u-1", theme: "dark", locale: "en-US" }),
		);
		const row = await db
			.select()
			.from(userSettings)
			.where(eq(userSettings.userId, "u-1"))
			.get();
		expect(row?.theme).toBe("dark");
	});

	test("GET /api/userSettings lists all rows", async () => {
		const { rest } = setupRest();
		await rest(
			req("POST", "/api/userSettings", { userId: "u-1", theme: "dark", locale: "en-US" }),
		);
		await rest(
			req("POST", "/api/userSettings", { userId: "u-2", theme: "light", locale: "fr-FR" }),
		);

		const list = await (await rest(req("GET", "/api/userSettings"))).json();
		expect(list).toHaveLength(2);
		expect(list.map((r: { userId: string }) => r.userId).sort()).toEqual(["u-1", "u-2"]);
	});

	test("GET /api/userSettings/:id looks up by pk field", async () => {
		const { rest } = setupRest();
		await rest(
			req("POST", "/api/userSettings", { userId: "u-1", theme: "dark", locale: "en-US" }),
		);

		const res = await rest(req("GET", "/api/userSettings/u-1"));
		expect(res.status).toBe(200);
		const row = await res.json();
		expect(row).toEqual({ userId: "u-1", theme: "dark", locale: "en-US" });
	});

	test("GET /api/userSettings/:id returns 404 for missing row", async () => {
		const { rest } = setupRest();
		const res = await rest(req("GET", "/api/userSettings/nope"));
		expect(res.status).toBe(404);
	});

	test("PATCH /api/userSettings/:id updates by pk", async () => {
		const { rest, db } = setupRest();
		await rest(
			req("POST", "/api/userSettings", { userId: "u-1", theme: "dark", locale: "en-US" }),
		);

		const res = await rest(req("PATCH", "/api/userSettings/u-1", { theme: "light" }));
		expect(res.status).toBe(200);

		const row = await db
			.select()
			.from(userSettings)
			.where(eq(userSettings.userId, "u-1"))
			.get();
		expect(row?.theme).toBe("light");
		expect(row?.locale).toBe("en-US"); // unchanged
	});

	test("PATCH strips pk from payload (cannot mutate primary key)", async () => {
		const { rest, db } = setupRest();
		await rest(
			req("POST", "/api/userSettings", { userId: "u-1", theme: "dark", locale: "en-US" }),
		);

		// Attempt to mutate the PK via payload — should be stripped
		await rest(
			req("PATCH", "/api/userSettings/u-1", { userId: "u-hacked", theme: "light" }),
		);

		// Original row still exists with original PK
		const rows = await db.select().from(userSettings).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.userId).toBe("u-1");
		expect(rows[0]!.theme).toBe("light");
	});

	test("DELETE /api/userSettings/:id removes by pk", async () => {
		const { rest, db } = setupRest();
		await rest(
			req("POST", "/api/userSettings", { userId: "u-1", theme: "dark", locale: "en-US" }),
		);

		const res = await rest(req("DELETE", "/api/userSettings/u-1"));
		expect(res.status).toBe(200);

		const rows = await db.select().from(userSettings).all();
		expect(rows).toHaveLength(0);
	});
});

// ── Sync protocol (bootstrap) setup ─────────────────────────────────────

function createMockStorage(): StorageAdapter {
	const store = new Map<
		string,
		{ row: Record<string, unknown>; colClocks: Record<string, string>; hlc: string }
	>();

	return {
		async getRow(table, rowId) {
			const entry = store.get(`${table}:${rowId}`);
			return entry
				? { row: entry.row, rowHlc: entry.hlc, colClocks: entry.colClocks }
				: { row: null, rowHlc: null, colClocks: {} };
		},
		async putRow(table, rowId, row, colClocks, hlc) {
			const key = `${table}:${rowId}`;
			if (row === null) {
				store.delete(key);
			} else {
				store.set(key, { row, colClocks, hlc });
			}
		},
		async getRows(table) {
			const rows: Record<string, unknown>[] = [];
			const colClocks: Record<string, Record<string, string>> = {};
			for (const [key, entry] of store) {
				if (key.startsWith(`${table}:`)) {
					rows.push(entry.row);
					const rowId = key.slice(table.length + 1);
					colClocks[rowId] = entry.colClocks;
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

describe("Sync bootstrap with non-id primary key", () => {
	test("snapshot keys colClocks by the pk field", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({
			transport,
			serverId: "test-server",
			db: {},
		});
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "tester" }));

		// Seed two rows with non-id PK
		await storage.putRow(
			"user_settings",
			"u-1",
			{ userId: "u-1", theme: "dark", locale: "en-US" },
			{},
			"",
		);
		await storage.putRow(
			"user_settings",
			"u-2",
			{ userId: "u-2", theme: "light", locale: "fr-FR" },
			{},
			"",
		);

		handler.setQuery("userSettings", {
			name: "userSettings",
			callback: async () => {
				const { rows } = await storage.getRows("user_settings");
				return rows;
			},
			tableDependencies: new Set(["user_settings"]),
			options: {
				tables: ["user_settings"],
				pk: "userId",
				conflict: "lww",
				readonly: [],
				mutate: async () => {},
			},
		});

		// Connect + hello
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "tok",
		});
		await new Promise((r) => setTimeout(r, 10));

		// Declare sync for the table
		transport.messageHandler!("client1", { type: "sync_declare", table: "userSettings" });
		await new Promise((r) => setTimeout(r, 10));

		// Bootstrap
		transport.messageHandler!("client1", { type: "bootstrap" });
		await new Promise((r) => setTimeout(r, 20));

		// Find the snapshot
		const snapshot = transport.sentMessages.find(
			(m) => m.message.type === "snapshot" && m.message.table === "userSettings",
		)?.message as SnapshotMessage | undefined;
		expect(snapshot).toBeDefined();
		expect(snapshot!.rows).toHaveLength(2);
		// colClocks should be keyed by userId values, not undefined/""
		expect(Object.keys(snapshot!.colClocks).sort()).toEqual(["u-1", "u-2"]);

		// bootstrap_complete should include pk in tableMeta
		const complete = transport.sentMessages.find((m) => m.message.type === "bootstrap_complete")
			?.message as BootstrapCompleteMessage | undefined;
		expect(complete).toBeDefined();
		expect(complete!.tableMeta.userSettings?.pk).toBe("userId");
	});
});
