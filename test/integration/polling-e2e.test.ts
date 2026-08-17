import { describe, expect, test } from "bun:test";
import { SyncClient } from "../../src/client/sync-client.ts";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { createPollingServerTransport } from "../../src/transport/polling.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type { ClientMessage, ServerMessage, ClientTransport } from "../../src/core/types.ts";
import { packHlc } from "../../src/core/hlc.ts";

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

// ── Polling loopback: pipes client↔server via queue drain ───────────────────

function createPollingLoopback(): {
	clientTransport: ClientTransport;
	serverTransport: ReturnType<typeof createPollingServerTransport>;
	clientId: string;
	drain(): void;
} {
	const clientId = "poll-client-1";
	const serverTransport = createPollingServerTransport();

	let clientHandler: ((msg: ServerMessage) => void) | null = null;

	// Manually drain the server queue → client handler
	function drain(): void {
		const messages = serverTransport.handlePoll(clientId);
		for (const msg of messages) {
			clientHandler?.(msg);
		}
	}

	const clientTransport: ClientTransport = {
		async send(message: ClientMessage): Promise<void> {
			serverTransport.handleMessage(clientId, message);
		},
		subscribe(handler: (message: ServerMessage) => void): void {
			clientHandler = handler;
		},
		async close(): Promise<void> {
			serverTransport.handleDisconnect(clientId);
		},
	};

	return { clientTransport, serverTransport, clientId, drain };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Polling end-to-end", () => {
	test("full lifecycle: connect → sync → insert → poll → ack", async () => {
		const { clientTransport, serverTransport, clientId, drain } = createPollingLoopback();

		const storage = createInMemoryStorage();
		const handler = new MessageHandler({
			transport: serverTransport,
			serverId: "poll-e2e",
			db: {},
		});
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("items", {
			name: "items",
			callback: () => {},
			tableDependencies: new Set(["items"]),
			options: {
				tables: ["items"],
				conflict: "lww",
				mutate: async (op) => {
					if (op.type === "delete") {
						await storage.putRow("items", op.rowId, null, {}, op.hlc);
					} else {
						await storage.putRow("items", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
					}
				},
			},
		});

		// Register client AFTER handler so onConnect fires
		serverTransport.handleConnect(clientId);

		const errors: Array<{ reason: string }> = [];
		const client = new SyncClient({
			clientId,
			transport: clientTransport,
			token: "valid",
			onError: (e) => errors.push(e),
		});

		// Connect — message queued, drain to deliver hello_ack
		const connectPromise = client.connect();
		await tick();
		drain();
		await connectPromise;
		expect(client.getState()).toBe("connected");

		// Sync + bootstrap
		await client.sync("items");
		const bootstrapPromise = client.bootstrap();
		await tick();
		drain();
		await bootstrapPromise;
		expect(client.getState()).toBe("synced");

		// Insert locally
		client.insert("items", "i-1", { name: "Poll Test" });
		expect(client.getRow("items", "i-1")).toEqual({ id: "i-1", name: "Poll Test" });
		expect(client.getPendingCount()).toBe(1);

		// Push to server, drain ack
		await client.push();
		await tick();
		drain();
		await tick();

		expect(client.getPendingCount()).toBe(0);
		expect(errors.length).toBe(0);
	});

	test("two clients: insert from A, poll delivers delta to B", async () => {
		const serverTransport = createPollingServerTransport();
		const storage = createInMemoryStorage();
		const handler = new MessageHandler({
			transport: serverTransport,
			serverId: "poll-e2e-2",
			db: { storage },
		});
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("items", {
			name: "items",
			callback: async (_ctx: unknown, db: { storage: StorageAdapter }) => {
				const { rows } = await db.storage.getRows("items");
				return rows;
			},
			tableDependencies: new Set(["items"]),
			options: {
				tables: ["items"],
				conflict: "lww",
				mutate: async (op) => {
					if (op.type === "delete") {
						await storage.putRow("items", op.rowId, null, {}, op.hlc);
					} else {
						await storage.putRow("items", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
					}
				},
			},
		});

		// Register both clients
		serverTransport.handleConnect("clientA");
		serverTransport.handleConnect("clientB");

		// Both hello
		serverTransport.handleMessage("clientA", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "clientA",
			token: "valid",
		});
		serverTransport.handleMessage("clientB", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "clientB",
			token: "valid",
		});
		await tick();

		// Both subscribe
		serverTransport.handleMessage("clientA", { type: "sync_declare", table: "items" });
		serverTransport.handleMessage("clientB", { type: "sync_declare", table: "items" });
		await tick();

		// Drain hello_acks so queues are clean
		serverTransport.handlePoll("clientA");
		serverTransport.handlePoll("clientB");

		// Client A inserts
		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		serverTransport.handleMessage("clientA", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-poll-1",
					table: "items",
					op: "insert",
					rowId: "r1",
					payload: { name: "from A" },
					hlc,
				},
			],
		});
		await tick();

		// Poll both clients
		const messagesA = serverTransport.handlePoll("clientA");
		const messagesB = serverTransport.handlePoll("clientB");

		// Client A gets ack
		const ackA = messagesA.find((m) => m.type === "ack");
		expect(ackA).toBeDefined();

		// Client B gets delta
		const deltaB = messagesB.find((m) => m.type === "delta");
		expect(deltaB).toBeDefined();
		expect((deltaB as { table: string }).table).toBe("items");
		expect((deltaB as { rowId: string }).rowId).toBe("r1");
		expect((deltaB as { payload: { name: string } }).payload.name).toBe("from A");

		// Client A should NOT get a delta
		const deltaA = messagesA.find((m) => m.type === "delta");
		expect(deltaA).toBeUndefined();
	});
});

function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
