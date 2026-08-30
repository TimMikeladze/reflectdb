import { describe, expect, test } from "bun:test";
import { SyncClient } from "../../src/client/sync-client.ts";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { createWsServerTransport } from "../../src/transport/ws.ts";
import type { WebSocketLike } from "../../src/transport/ws.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import { packHlc } from "../../src/core/hlc.ts";
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

	// ── The writer's own cached result set ───────────────────────────────
	//
	// A writer is excluded from the fanout of its own op because it already
	// applied it optimistically. The server still has to advance that client's
	// cached result set by hand, or the cache keeps describing the row as it was
	// BEFORE the write and a peer setting the column back to that value diffs as
	// "no change".

	/** Two clients subscribed to `todos`, seeded with one row. */
	async function twoClients(serverSet?: Record<string, unknown>) {
		const serverWs = createWsServerTransport();
		const storage = createInMemoryStorage();
		await storage.putRow("todos", "t1", { id: "t1", text: "a", done: false }, {}, "0.0.seed");

		const handler = new MessageHandler({ transport: serverWs, serverId: "wc", db: { storage } });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "u" }));
		handler.setQuery("todos", {
			name: "todos",
			callback: async (_ctx: unknown, db: { storage: StorageAdapter }) =>
				(await db.storage.getRows("todos")).rows,
			tableDependencies: new Set(["todos"]),
			options: {
				tables: ["todos"],
				conflict: "lww",
				...(serverSet ? { serverSet } : {}),
				mutate: async (op) => {
					if (op.type === "delete") return storage.putRow("todos", op.rowId, null, {}, op.hlc);
					const prev = (await storage.getRow("todos", op.rowId)).row ?? {};
					await storage.putRow(
						"todos",
						op.rowId,
						{ ...prev, ...op.payload, id: op.rowId },
						{},
						op.hlc,
					);
				},
			},
		});

		const received: Record<string, ServerMessage[]> = { A: [], B: [] };
		for (const id of ["A", "B"] as const) {
			const ws: WebSocketLike = {
				send: (d) => {
					received[id]!.push(JSON.parse(d as string));
				},
				close() {},
			};
			serverWs.handleOpen(id, ws);
			serverWs.handleMessage(
				id,
				JSON.stringify({
					type: "hello",
					protocolVersion: PROTOCOL_VERSION,
					clientId: id,
					token: "valid",
				}),
			);
			serverWs.handleMessage(id, JSON.stringify({ type: "sync_declare", table: "todos" }));
		}
		await tick();
		for (const id of ["A", "B"]) {
			serverWs.handleMessage(id, JSON.stringify({ type: "bootstrap", tables: ["todos"] }));
		}
		await tick();

		let counter = 0;
		const write = async (client: "A" | "B", payload: Record<string, unknown>) => {
			counter += 1;
			serverWs.handleMessage(
				client,
				JSON.stringify({
					type: "ops",
					token: "valid",
					ops: [
						{
							id: `op-${counter}`,
							table: "todos",
							op: "update",
							rowId: "t1",
							payload,
							hlc: packHlc({ ms: Date.now() + counter, counter: 0, nodeId: `client:${client}` }),
						},
					],
				}),
			);
			await tick();
		};

		const deltasTo = (client: "A" | "B") =>
			received[client]!.filter((m) => m.type === "delta").map(
				(m) => (m as { payload: Record<string, unknown> }).payload,
			);

		return { received, write, deltasTo };
	}

	test("a peer reverting a column the writer just wrote still reaches the writer", async () => {
		const { received, write, deltasTo } = await twoClients();

		// A sets done=true. A is excluded from the fanout of its own op.
		await write("A", { done: true });
		received.A!.length = 0;

		// B sets it back to false — the value A's cached result set held before
		// A's write. Without the writer-cache patch this diffs as "no change"
		// and A is never told, leaving the two clients permanently diverged.
		await write("B", { done: false });

		expect(deltasTo("A")).toEqual([{ done: false }]);
	});

	test("a peer setting a different value still reaches the writer", async () => {
		const { received, write, deltasTo } = await twoClients();

		await write("A", { done: true });
		received.A!.length = 0;

		await write("B", { text: "b" });

		expect(deltasTo("A")).toEqual([{ text: "b" }]);
	});

	test("the writer is still told the serverSet columns it never applied", async () => {
		// The client strips serverSet fields from its optimistic row, so the
		// writer's cache must NOT claim them — otherwise this delta disappears.
		const { received, write, deltasTo } = await twoClients({ orgId: "org-1" });

		received.A!.length = 0;
		await write("A", { done: true });
		await write("B", { text: "b" });

		expect(deltasTo("A")).toEqual([{ text: "b", orgId: "org-1" }]);
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
		expect(client.getRow("posts", "existing-row")).toEqual({
			id: "existing-row",
			title: "client-version",
		});

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
