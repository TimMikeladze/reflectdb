import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { createMockTransport } from "./helpers.ts";
import { packHlc } from "../../src/core/hlc.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";

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
			else store.set(`${table}:${rowId}`, { row: { ...row, id: rowId }, colClocks, hlc });
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

async function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function connectClient(
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
): Promise<void> {
	transport.connectHandler!(clientId, new Request("https://sync"));
	transport.messageHandler!(clientId, {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId,
		token: "valid",
	});
	await tick();
}

describe("Room-based broadcasting", () => {
	test("deltas are scoped to the matching room", async () => {
		const transport = createMockTransport();
		const storage = createInMemoryStorage();

		const server = createServer({
			db: { storage },
			transport,
			storage,
		});

		server.auth(async () => ({ userId: "user1" }));
		server.query(
			"posts",
			async (_ctx, db: { storage: StorageAdapter }) => {
				const { rows } = await db.storage.getRows("posts");
				return rows;
			},
			{
				tables: ["posts"],
				conflict: "lww",
				mutate: async (op) => {
					if (op.type === "delete") {
						await storage.putRow("posts", op.rowId, null, {}, op.hlc);
					} else {
						await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
					}
				},
			},
		);
		server.room("org/:orgId", () => {});

		// Connect 3 clients
		await connectClient(transport, "client-acme-1");
		await connectClient(transport, "client-acme-2");
		await connectClient(transport, "client-other");

		// Two clients subscribe to posts in org "acme"
		transport.messageHandler!("client-acme-1", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme" },
		});
		await tick();

		transport.messageHandler!("client-acme-2", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme" },
		});
		await tick();

		// One client subscribes to posts in org "other"
		transport.messageHandler!("client-other", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "other" },
		});
		await tick();

		transport.sentMessages.length = 0;

		// client-acme-1 inserts a post
		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:acme1" });
		transport.messageHandler!("client-acme-1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-room-1",
					table: "posts",
					op: "insert",
					rowId: "row-acme",
					payload: { title: "Acme post", orgId: "acme" },
					hlc,
				},
			],
		});
		await tick();

		// client-acme-2 should receive the delta
		const acme2Deltas = transport.sentMessages.filter(
			(m) => m.clientId === "client-acme-2" && m.message.type === "delta",
		);
		expect(acme2Deltas.length).toBe(1);

		// client-other should NOT receive the delta (different room)
		const otherDeltas = transport.sentMessages.filter(
			(m) => m.clientId === "client-other" && m.message.type === "delta",
		);
		expect(otherDeltas.length).toBe(0);
	});

	test("clients without room params receive all deltas when no rooms registered", async () => {
		const transport = createMockTransport();
		const storage = createInMemoryStorage();

		const server = createServer({
			db: { storage },
			transport,
			storage,
		});

		server.auth(async () => ({ userId: "user1" }));
		server.query(
			"posts",
			async (_ctx, db: { storage: StorageAdapter }) => {
				const { rows } = await db.storage.getRows("posts");
				return rows;
			},
			{
				tables: ["posts"],
				conflict: "lww",
				mutate: async (op) => {
					if (op.type === "delete") {
						await storage.putRow("posts", op.rowId, null, {}, op.hlc);
					} else {
						await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
					}
				},
			},
		);
		// No rooms registered

		await connectClient(transport, "client-a");
		await connectClient(transport, "client-b");

		transport.messageHandler!("client-a", { type: "sync_declare", table: "posts" });
		await tick();
		transport.messageHandler!("client-b", { type: "sync_declare", table: "posts" });
		await tick();

		transport.sentMessages.length = 0;

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client-a", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-norroom-1",
					table: "posts",
					op: "insert",
					rowId: "row-1",
					payload: { title: "Hello" },
					hlc,
				},
			],
		});
		await tick();

		const bDeltas = transport.sentMessages.filter(
			(m) => m.clientId === "client-b" && m.message.type === "delta",
		);
		expect(bDeltas.length).toBe(1);
	});

	test("room callback is invoked on sync_declare", async () => {
		const transport = createMockTransport();
		const storage = createInMemoryStorage();

		const roomJoins: Array<{ params: Record<string, string> }> = [];

		const server = createServer({
			db: {},
			transport,
			storage,
		});

		server.auth(async () => ({ userId: "user1" }));
		server.query("posts", () => {}, { tables: ["posts"], conflict: "lww", mutate: async () => {} });
		server.room("org/:orgId", (ctx) => {
			roomJoins.push({ params: ctx.params });
		});

		await connectClient(transport, "client-1");

		transport.messageHandler!("client-1", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme" },
		});
		await tick();

		expect(roomJoins.length).toBe(1);
		expect(roomJoins[0]!.params).toEqual({ orgId: "acme" });
	});

	test("multi-segment room pattern works", async () => {
		const transport = createMockTransport();
		const storage = createInMemoryStorage();

		const server = createServer({
			db: { storage },
			transport,
			storage,
		});

		server.auth(async () => ({ userId: "user1" }));
		server.query(
			"posts",
			async (_ctx, db: { storage: StorageAdapter }) => {
				const { rows } = await db.storage.getRows("posts");
				return rows;
			},
			{
				tables: ["posts"],
				conflict: "lww",
				mutate: async (op) => {
					if (op.type === "delete") {
						await storage.putRow("posts", op.rowId, null, {}, op.hlc);
					} else {
						await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
					}
				},
			},
		);
		server.room("org/:orgId/team/:teamId", () => {});

		await connectClient(transport, "client-a");
		await connectClient(transport, "client-b");
		await connectClient(transport, "client-c");

		// client-a and client-b in same org+team
		transport.messageHandler!("client-a", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme", teamId: "eng" },
		});
		await tick();

		transport.messageHandler!("client-b", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme", teamId: "eng" },
		});
		await tick();

		// client-c in same org but different team
		transport.messageHandler!("client-c", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme", teamId: "design" },
		});
		await tick();

		transport.sentMessages.length = 0;

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client-a", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-multi-1",
					table: "posts",
					op: "insert",
					rowId: "row-team",
					payload: { title: "Team post" },
					hlc,
				},
			],
		});
		await tick();

		// client-b (same room) gets delta
		const bDeltas = transport.sentMessages.filter(
			(m) => m.clientId === "client-b" && m.message.type === "delta",
		);
		expect(bDeltas.length).toBe(1);

		// client-c (different room) does not
		const cDeltas = transport.sentMessages.filter(
			(m) => m.clientId === "client-c" && m.message.type === "delta",
		);
		expect(cDeltas.length).toBe(0);
	});

	test("room callback returning { ok: false } rejects subscription", async () => {
		const transport = createMockTransport();
		const storage = createInMemoryStorage();

		const server = createServer({
			db: { storage },
			transport,
			storage,
		});

		server.auth(async () => ({ userId: "user1" }));
		server.query(
			"posts",
			async (_ctx, db: { storage: StorageAdapter }) => {
				const { rows } = await db.storage.getRows("posts");
				return rows;
			},
			{
				tables: ["posts"],
				conflict: "lww",
				mutate: async (op) => {
					if (op.type === "delete") {
						await storage.putRow("posts", op.rowId, null, {}, op.hlc);
					} else {
						await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
					}
				},
			},
		);
		server.room("org/:orgId", ({ params }) => {
			if (params.orgId === "forbidden") {
				return { ok: false, reason: "Access denied to this org" };
			}
		});

		await connectClient(transport, "client1");
		transport.sentMessages.length = 0;

		// Try to subscribe to a forbidden room
		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "forbidden" },
		});
		await tick();

		// Should receive a disconnect with the rejection reason
		const disconnects = transport.sentMessages.filter(
			(m) => m.clientId === "client1" && m.message.type === "disconnect",
		);
		expect(disconnects.length).toBe(1);
		expect((disconnects[0]!.message as { reason: string }).reason).toBe(
			"Access denied to this org",
		);
	});
});
