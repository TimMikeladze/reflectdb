import { describe, expect, test } from "bun:test";
import { SyncClient } from "../../src/client/sync-client.ts";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { createSseServerTransport } from "../../src/transport/sse.ts";
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

// ── SSE loopback: pipes client↔server via SSE stream + direct calls ─────────

function createSseLoopback(): {
	clientTransport: ClientTransport;
	serverTransport: ReturnType<typeof createSseServerTransport>;
	clientId: string;
} {
	const clientId = "sse-client-1";
	const serverTransport = createSseServerTransport();

	let clientHandler: ((msg: ServerMessage) => void) | null = null;
	let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	async function readStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			const text = decoder.decode(value);
			// SSE format: "data: {...}\n\n"
			const lines = text.split("\n");
			for (const line of lines) {
				if (line.startsWith("data: ")) {
					const json = line.slice(6);
					const msg = JSON.parse(json) as ServerMessage;
					clientHandler?.(msg);
				}
			}
		}
	}

	const clientTransport: ClientTransport = {
		async send(message: ClientMessage): Promise<void> {
			serverTransport.handleMessage(clientId, message);
		},
		subscribe(handler: (message: ServerMessage) => void): void {
			clientHandler = handler;
			// Create the SSE stream and start reading
			const stream = serverTransport.createEventStream(clientId);
			streamReader = stream.getReader();
			readStream(streamReader);
		},
		async close(): Promise<void> {
			if (streamReader) {
				await streamReader.cancel();
				streamReader = null;
			}
			serverTransport.handleDisconnect(clientId);
		},
	};

	return { clientTransport, serverTransport, clientId };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SSE end-to-end", () => {
	test("full lifecycle: connect → sync → insert → ack", async () => {
		const { clientTransport, serverTransport, clientId } = createSseLoopback();

		const storage = createInMemoryStorage();
		const handler = new MessageHandler({
			transport: serverTransport,
			serverId: "sse-e2e",
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

		const errors: Array<{ reason: string }> = [];
		const client = new SyncClient({
			clientId,
			transport: clientTransport,
			token: "valid",
			onError: (e) => errors.push(e),
		});

		await client.connect();
		await tick();
		expect(client.getState()).toBe("connected");

		await client.sync("items");
		await tick();

		await client.bootstrap();
		await tick();
		expect(client.getState()).toBe("synced");

		client.insert("items", "i-1", { name: "Test Item" });
		expect(client.getRow("items", "i-1")).toEqual({ name: "Test Item" });
		expect(client.getPendingCount()).toBe(1);

		await client.push();
		await tick();

		expect(client.getPendingCount()).toBe(0);
		expect(errors.length).toBe(0);
	});

	test("two clients: insert from A broadcasts delta to B", async () => {
		const serverTransport = createSseServerTransport();
		const storage = createInMemoryStorage();
		const handler = new MessageHandler({
			transport: serverTransport,
			serverId: "sse-e2e-2",
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

		// Collect messages for each client via their SSE streams
		const receivedByA: ServerMessage[] = [];
		const receivedByB: ServerMessage[] = [];
		const decoder = new TextDecoder();

		function readSseStream(
			reader: ReadableStreamDefaultReader<Uint8Array>,
			target: ServerMessage[],
		): void {
			(async () => {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					const text = decoder.decode(value);
					for (const line of text.split("\n")) {
						if (line.startsWith("data: ")) {
							target.push(JSON.parse(line.slice(6)) as ServerMessage);
						}
					}
				}
			})();
		}

		const streamA = serverTransport.createEventStream("clientA");
		readSseStream(streamA.getReader(), receivedByA);

		const streamB = serverTransport.createEventStream("clientB");
		readSseStream(streamB.getReader(), receivedByB);

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

		receivedByA.length = 0;
		receivedByB.length = 0;

		// Client A inserts
		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		serverTransport.handleMessage("clientA", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-sse-1",
					table: "items",
					op: "insert",
					rowId: "r1",
					payload: { name: "from A" },
					hlc,
				},
			],
		});
		await tick();

		// Client A gets ack
		const ackA = receivedByA.find((m) => m.type === "ack");
		expect(ackA).toBeDefined();

		// Client B gets delta
		const deltaB = receivedByB.find((m) => m.type === "delta");
		expect(deltaB).toBeDefined();
		expect((deltaB as { table: string }).table).toBe("items");
		expect((deltaB as { rowId: string }).rowId).toBe("r1");
		expect((deltaB as { payload: { name: string } }).payload.name).toBe("from A");

		// Client A should NOT get a delta
		const deltaA = receivedByA.find((m) => m.type === "delta");
		expect(deltaA).toBeUndefined();
	});

	test("disconnect fires handler", async () => {
		const { clientTransport, serverTransport, clientId } = createSseLoopback();

		let disconnected = "";
		serverTransport.onDisconnect((id) => {
			disconnected = id;
		});

		// Subscribe to start the stream
		clientTransport.subscribe(() => {});
		await tick();

		await clientTransport.close();
		expect(disconnected).toBe(clientId);
	});
});

function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
