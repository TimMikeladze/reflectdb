import { describe, expect, test } from "bun:test";
import { SyncClient } from "../../src/client/sync-client.ts";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { createWsServerTransport } from "../../src/transport/ws.ts";
import type { WebSocketLike } from "../../src/transport/ws.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type { ClientMessage, ServerMessage, ClientTransport } from "../../src/core/types.ts";

// ── In-memory storage ───────────────────────────────────────────────────────

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
			if (row === null) {
				store.delete(`${table}:${rowId}`);
			} else {
				store.set(`${table}:${rowId}`, { row: { ...row, id: rowId }, colClocks, hlc });
			}
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

// ── Loopback transport: directly pipes client↔server messages ───────────────

function createLoopbackTransport(): {
	client: ClientTransport;
	serverWs: ReturnType<typeof createWsServerTransport>;
	mockWs: WebSocketLike;
} {
	const serverWs = createWsServerTransport();

	// A mock WS that sends data back to the client handler
	let clientHandler: ((msg: ServerMessage) => void) | null = null;

	const mockWs: WebSocketLike = {
		send(data: string): void {
			// Server → Client: parse and forward to client handler
			const msg = JSON.parse(data) as ServerMessage;
			clientHandler?.(msg);
		},
		close(): void {},
	};

	const clientTransport: ClientTransport = {
		async send(message: ClientMessage): Promise<void> {
			// Client → Server: serialize and forward to server ws handler
			serverWs.handleMessage("client1", JSON.stringify(message));
		},
		subscribe(handler: (message: ServerMessage) => void): void {
			clientHandler = handler;
		},
		async close(): Promise<void> {},
	};

	return { client: clientTransport, serverWs, mockWs };
}

describe("End-to-end sync flow", () => {
	test("full lifecycle: connect → sync → insert → ack → delta", async () => {
		const { client: clientTransport, serverWs, mockWs } = createLoopbackTransport();

		// Set up server
		const storage = createInMemoryStorage();
		const handler = new MessageHandler({
			transport: serverWs,
			serverId: "e2e-server",
			db: {},
		});
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: () => {},
			tableDependencies: new Set(["posts"]),
			options: {
				tables: ["posts"],
				conflict: "lww",
				serverSet: { orgId: "org-e2e" },
				mutate: async (op) => {
					if (op.type === "delete") {
						await storage.putRow("posts", op.rowId, null, {}, op.hlc);
					} else {
						await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
					}
				},
			},
		});

		// Track events on client
		const syncEvents: string[] = [];
		const errors: Array<{ reason: string }> = [];

		const client = new SyncClient({
			clientId: "client1",
			transport: clientTransport,
			token: "valid",
			onSync: (t) => syncEvents.push(t),
			onError: (e) => errors.push(e),
		});

		// 1. Connect
		serverWs.handleOpen("client1", mockWs);
		await client.connect();
		await tick();
		expect(client.getState()).toBe("connected");

		// 2. Declare sync
		await client.sync("posts");
		await tick();

		// 3. Bootstrap
		await client.bootstrap();
		await tick();
		expect(client.getState()).toBe("synced");

		// 4. Insert locally
		const op = client.insert("posts", "row-1", { title: "hello" });
		expect(client.getRow("posts", "row-1")).toEqual({ id: "row-1", title: "hello" });
		expect(client.getPendingCount()).toBe(1);

		// 5. Push to server
		await client.push();
		await tick();

		// Should be acked
		expect(client.getPendingCount()).toBe(0);
		expect(errors.length).toBe(0);
	});

	test("two clients: insert from A broadcasts delta to B", async () => {
		const serverWs = createWsServerTransport();
		const storage = createInMemoryStorage();
		const handler = new MessageHandler({
			transport: serverWs,
			serverId: "e2e-2",
			db: { storage },
		});
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: async (
				_ctx: { auth: { userId: string }; params: Record<string, unknown> },
				db: { storage: StorageAdapter },
			) => {
				const { rows } = await db.storage.getRows("posts");
				return rows;
			},
			tableDependencies: new Set(["posts"]),
			options: {
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
		});

		// Client A
		const receivedByA: ServerMessage[] = [];
		const wsA: WebSocketLike = {
			send(data) {
				receivedByA.push(JSON.parse(data));
			},
			close() {},
		};
		serverWs.handleOpen("clientA", wsA);

		// Client B
		const receivedByB: ServerMessage[] = [];
		const wsB: WebSocketLike = {
			send(data) {
				receivedByB.push(JSON.parse(data));
			},
			close() {},
		};
		serverWs.handleOpen("clientB", wsB);

		// Both hello
		serverWs.handleMessage(
			"clientA",
			JSON.stringify({
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				clientId: "clientA",
				token: "valid",
			}),
		);
		serverWs.handleMessage(
			"clientB",
			JSON.stringify({
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				clientId: "clientB",
				token: "valid",
			}),
		);
		await tick();

		// Both subscribe to posts
		serverWs.handleMessage("clientA", JSON.stringify({ type: "sync_declare", table: "posts" }));
		serverWs.handleMessage("clientB", JSON.stringify({ type: "sync_declare", table: "posts" }));
		await tick();

		receivedByA.length = 0;
		receivedByB.length = 0;

		// Client A inserts
		const hlc = (await import("../../src/core/hlc.ts")).packHlc({
			ms: Date.now(),
			counter: 0,
			nodeId: "client:a",
		});
		serverWs.handleMessage(
			"clientA",
			JSON.stringify({
				type: "ops",
				token: "valid",
				ops: [
					{
						id: "op-x",
						table: "posts",
						op: "insert",
						rowId: "rx",
						payload: { title: "from A" },
						hlc,
					},
				],
			}),
		);
		await tick();

		// Client A gets ack
		const ackA = receivedByA.find((m) => m.type === "ack");
		expect(ackA).toBeDefined();

		// Client B gets delta
		const deltaB = receivedByB.find((m) => m.type === "delta");
		expect(deltaB).toBeDefined();
		expect((deltaB as { table: string }).table).toBe("posts");
		expect((deltaB as { rowId: string }).rowId).toBe("rx");
		expect((deltaB as { payload: { title: string } }).payload.title).toBe("from A");

		// Client A should NOT get a delta (excluded)
		const deltaA = receivedByA.find((m) => m.type === "delta");
		expect(deltaA).toBeUndefined();
	});

	test("rejected op reverts client state", async () => {
		const { client: clientTransport, serverWs, mockWs } = createLoopbackTransport();

		const storage = createInMemoryStorage();
		// Pre-populate a row so conflict resolution rejects the client's write
		await storage.putRow(
			"posts",
			"existing-row",
			{ title: "server-version" },
			{ _row: "9999999999999999999.0000.server:1" },
			"9999999999999999999.0000.server:1",
		);

		const handler = new MessageHandler({
			transport: serverWs,
			serverId: "e2e-reject",
			db: {},
		});
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: () => {},
			tableDependencies: new Set(["posts"]),
			options: {
				tables: ["posts"],
				conflict: "server",
				mutate: async (op) => {
					if (op.type === "delete") {
						await storage.putRow("posts", op.rowId, null, {}, op.hlc);
					} else {
						await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
					}
				},
			},
		});

		const errors: Array<{ reason: string }> = [];
		const client = new SyncClient({
			clientId: "client1",
			transport: clientTransport,
			token: "valid",
			onError: (e) => errors.push(e),
		});

		serverWs.handleOpen("client1", mockWs);
		await client.connect();
		await tick();

		await client.sync("posts");
		await tick();

		// Client tries to insert into existing row (conflict with server)
		client.insert("posts", "existing-row", { title: "client-version" });
		expect(client.getRow("posts", "existing-row")).toEqual({ id: "existing-row", title: "client-version" });

		await client.push();
		await tick();

		// Should be rejected
		expect(errors.length).toBe(1);
		expect(errors[0]!.reason).toBe("server_conflict");
	});
});

function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
