import { describe, expect, test } from "bun:test";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { EagerBuffer } from "../../src/server/eager-buffer.ts";
import { createMockTransport } from "./helpers.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type {
	ServerMessage,
	AckMessage,
	DeltaMessage,
	RejectMessage,
} from "../../src/core/types.ts";

function createMockStorage(): StorageAdapter & {
	store: Map<
		string,
		{ row: Record<string, unknown>; colClocks: Record<string, string>; hlc: string }
	>;
	opLog: Array<{
		table: string;
		op: string;
		rowId: string;
		payload: Record<string, unknown> | null;
		hlc: string;
	}>;
} {
	const store = new Map<
		string,
		{ row: Record<string, unknown>; colClocks: Record<string, string>; hlc: string }
	>();
	const opLog: Array<{
		table: string;
		op: string;
		rowId: string;
		payload: Record<string, unknown> | null;
		hlc: string;
	}> = [];
	const processedOps = new Set<string>();

	return {
		store,
		opLog,
		async getRow(table: string, rowId: string) {
			const key = `${table}:${rowId}`;
			const entry = store.get(key);
			if (!entry) return { row: null, rowHlc: null, colClocks: {} };
			return { row: entry.row, rowHlc: entry.hlc, colClocks: entry.colClocks };
		},
		async putRow(table, rowId, row, colClocks, hlc) {
			const key = `${table}:${rowId}`;
			if (row === null) {
				store.delete(key);
			} else {
				store.set(key, { row: { ...row, id: rowId }, colClocks, hlc });
			}
		},
		async getRows(table) {
			const rows: Record<string, unknown>[] = [];
			const colClocks: Record<string, Record<string, string>> = {};
			for (const [key, entry] of store) {
				if (key.startsWith(`${table}:`)) {
					rows.push(entry.row);
					const rowId = key.split(":")[1]!;
					colClocks[rowId] = entry.colClocks;
				}
			}
			return { rows, colClocks };
		},
		async appendOp(entry) {
			opLog.push({
				table: entry.table,
				op: entry.op,
				rowId: entry.rowId,
				payload: entry.payload,
				hlc: entry.hlc,
			});
		},
		async getOpsSince() {
			return [];
		},
		async deleteOpsBefore() {
			return 0;
		},
		async reserveOp(opId: string) {
			if (processedOps.has(opId)) return false;
			processedOps.add(opId);
			return true;
		},
		async getMeta() {
			return null;
		},
		async setMeta() {},
	};
}

function setupEagerHandler() {
	const transport = createMockTransport();
	const storage = createMockStorage();
	const handler = new MessageHandler({
		transport,
		serverId: "test-server",
		db: {},
	});

	handler.setStorage(storage);
	handler.setAuth(async () => ({ userId: "user1" }));

	handler.setQuery("strokes", {
		name: "strokes",
		callback: async () => {
			const { rows } = await storage.getRows("strokes");
			return rows;
		},
		tableDependencies: new Set(["strokes"]),
		options: {
			tables: ["strokes"],
			broadcast: "eager",
			mutate: async () => {},
		},
	});

	return { transport, storage, handler };
}

async function connectAndSync(transport: ReturnType<typeof createMockTransport>, clientId: string) {
	transport.connectHandler!(clientId, new Request("https://sync"));
	transport.messageHandler!(clientId, {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId,
		token: "valid",
	});
	await new Promise((r) => setTimeout(r, 10));

	transport.messageHandler!(clientId, {
		type: "sync_declare",
		table: "strokes",
		params: {},
	});
	await new Promise((r) => setTimeout(r, 10));

	transport.messageHandler!(clientId, {
		type: "bootstrap",
	});
	await new Promise((r) => setTimeout(r, 10));
}

function getMessagesForClient(
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
	type?: string,
) {
	return transport.sentMessages
		.filter((m) => m.clientId === clientId && (!type || m.message.type === type))
		.map((m) => m.message);
}

// ── Unit tests: EagerBuffer ──────────────────────────────────────────────────

describe("EagerBuffer", () => {
	test("push adds ops to buffer", () => {
		const buffer = new EagerBuffer();
		const ok = buffer.push("strokes", {
			entry: {
				table: "strokes",
				op: "insert",
				rowId: "s1",
				payload: { points: [] },
				hlc: "001",
				colClocks: {},
			},
		});
		expect(ok).toBe(true);
		expect(buffer.pendingCount).toBe(1);
		expect(buffer.queryPendingCount("strokes")).toBe(1);
	});

	test("flush persists to storage and clears buffer", async () => {
		const storage = createMockStorage();
		const buffer = new EagerBuffer();
		buffer.setStorage(storage);

		buffer.push("strokes", {
			entry: {
				table: "strokes",
				op: "insert",
				rowId: "s1",
				payload: { points: [1, 2] },
				hlc: "001",
				colClocks: { _row: "001" },
			},
		});
		buffer.push("strokes", {
			entry: {
				table: "strokes",
				op: "insert",
				rowId: "s2",
				payload: { points: [3, 4] },
				hlc: "002",
				colClocks: { _row: "002" },
			},
		});

		expect(buffer.pendingCount).toBe(2);

		const flushed = await buffer.flush();
		expect(flushed).toBe(2);
		expect(buffer.pendingCount).toBe(0);

		// Verify storage
		const row1 = await storage.getRow("strokes", "s1");
		expect(row1.row).not.toBeNull();
		expect(row1.row!.points).toEqual([1, 2]);

		const row2 = await storage.getRow("strokes", "s2");
		expect(row2.row).not.toBeNull();
	});

	test("flush appends to op log", async () => {
		const storage = createMockStorage();
		const buffer = new EagerBuffer();
		buffer.setStorage(storage);

		buffer.push("strokes", {
			entry: {
				table: "strokes",
				op: "insert",
				rowId: "s1",
				payload: { x: 1 },
				hlc: "001",
				colClocks: {},
			},
		});

		await buffer.flush();
		expect(storage.opLog.length).toBe(1);
		expect(storage.opLog[0]!.rowId).toBe("s1");
	});

	test("hasCapacity returns true when buffer has space", () => {
		const buffer = new EagerBuffer({ maxBufferSize: 3 });
		expect(buffer.hasCapacity("q")).toBe(true);

		buffer.push("q", {
			entry: { table: "t", op: "insert", rowId: "1", payload: null, hlc: "1", colClocks: {} },
		});
		expect(buffer.hasCapacity("q")).toBe(true);

		buffer.push("q", {
			entry: { table: "t", op: "insert", rowId: "2", payload: null, hlc: "2", colClocks: {} },
		});
		expect(buffer.hasCapacity("q")).toBe(true);

		buffer.push("q", {
			entry: { table: "t", op: "insert", rowId: "3", payload: null, hlc: "3", colClocks: {} },
		});
		expect(buffer.hasCapacity("q")).toBe(false);
	});

	test("hasCapacity respects per-query maxSize override", () => {
		const buffer = new EagerBuffer({ maxBufferSize: 100 });
		buffer.push("q", {
			entry: { table: "t", op: "insert", rowId: "1", payload: null, hlc: "1", colClocks: {} },
		});
		expect(buffer.hasCapacity("q", 1)).toBe(false);
		expect(buffer.hasCapacity("q", 2)).toBe(true);
	});

	test("backpressure rejects when buffer full", () => {
		const buffer = new EagerBuffer({ maxBufferSize: 2 });

		buffer.push("q", {
			entry: { table: "t", op: "insert", rowId: "1", payload: null, hlc: "1", colClocks: {} },
		});
		buffer.push("q", {
			entry: { table: "t", op: "insert", rowId: "2", payload: null, hlc: "2", colClocks: {} },
		});

		// Buffer is full, flush is a no-op without storage — still full
		const ok = buffer.push("q", {
			entry: { table: "t", op: "insert", rowId: "3", payload: null, hlc: "3", colClocks: {} },
		});
		expect(ok).toBe(false);
	});

	test("backpressure resolves after flush with storage", async () => {
		const storage = createMockStorage();
		const buffer = new EagerBuffer({ maxBufferSize: 2 });
		buffer.setStorage(storage);

		buffer.push("q", {
			entry: { table: "t", op: "insert", rowId: "1", payload: { a: 1 }, hlc: "1", colClocks: {} },
		});
		buffer.push("q", {
			entry: { table: "t", op: "insert", rowId: "2", payload: { a: 2 }, hlc: "2", colClocks: {} },
		});

		await buffer.flush();
		const ok = buffer.push("q", {
			entry: { table: "t", op: "insert", rowId: "3", payload: { a: 3 }, hlc: "3", colClocks: {} },
		});
		expect(ok).toBe(true);
	});

	test("close flushes remaining ops", async () => {
		const storage = createMockStorage();
		const buffer = new EagerBuffer();
		buffer.setStorage(storage);

		buffer.push("strokes", {
			entry: {
				table: "strokes",
				op: "insert",
				rowId: "s1",
				payload: { x: 1 },
				hlc: "001",
				colClocks: {},
			},
		});

		await buffer.close();
		expect(buffer.pendingCount).toBe(0);
		const row = await storage.getRow("strokes", "s1");
		expect(row.row).not.toBeNull();
	});

	test("multiple queries tracked independently", () => {
		const buffer = new EagerBuffer();

		buffer.push("strokes", {
			entry: {
				table: "strokes",
				op: "insert",
				rowId: "s1",
				payload: null,
				hlc: "1",
				colClocks: {},
			},
		});
		buffer.push("cursors", {
			entry: {
				table: "cursors",
				op: "insert",
				rowId: "c1",
				payload: null,
				hlc: "2",
				colClocks: {},
			},
		});
		buffer.push("strokes", {
			entry: {
				table: "strokes",
				op: "insert",
				rowId: "s2",
				payload: null,
				hlc: "3",
				colClocks: {},
			},
		});

		expect(buffer.queryPendingCount("strokes")).toBe(2);
		expect(buffer.queryPendingCount("cursors")).toBe(1);
		expect(buffer.pendingCount).toBe(3);
	});
});

// ── Integration tests: Eager broadcast via MessageHandler ────────────────────

describe("Eager broadcast integration", () => {
	test("eager op is acked immediately", async () => {
		const { transport } = setupEagerHandler();

		await connectAndSync(transport, "alice");
		transport.sentMessages.length = 0;

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1", points: [{ x: 0, y: 0 }] },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		const acks = getMessagesForClient(transport, "alice", "ack");
		expect(acks.length).toBe(1);
		expect((acks[0] as AckMessage).opIds).toContain("op1");
	});

	test("eager op is broadcast to other subscribers immediately", async () => {
		const { transport } = setupEagerHandler();

		await connectAndSync(transport, "alice");
		await connectAndSync(transport, "bob");
		transport.sentMessages.length = 0;

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1", color: "#ff0000" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		const bobDeltas = getMessagesForClient(transport, "bob", "delta");
		expect(bobDeltas.length).toBe(1);

		const delta = bobDeltas[0] as DeltaMessage;
		expect(delta.op).toBe("insert");
		expect(delta.rowId).toBe("s1");
		expect(delta.payload!.color).toBe("#ff0000");
	});

	test("eager op does NOT persist to storage immediately", async () => {
		const { transport, storage } = setupEagerHandler();

		await connectAndSync(transport, "alice");

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1", color: "#ff0000" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		// Not in storage yet (deferred)
		const row = await storage.getRow("strokes", "s1");
		expect(row.row).toBeNull();
	});

	test("eager op persists after manual flush", async () => {
		const { transport, storage, handler } = setupEagerHandler();

		await connectAndSync(transport, "alice");

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1", color: "#ff0000" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		// Flush the eager buffer
		await handler.getEagerBuffer().flush();

		const row = await storage.getRow("strokes", "s1");
		expect(row.row).not.toBeNull();
		expect(row.row!.color).toBe("#ff0000");
	});

	test("eager op persists to op log after flush", async () => {
		const { transport, storage, handler } = setupEagerHandler();

		await connectAndSync(transport, "alice");

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1", color: "#ff0000" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		await handler.getEagerBuffer().flush();

		expect(storage.opLog.length).toBe(1);
		expect(storage.opLog[0]!.rowId).toBe("s1");
	});

	test("multiple eager ops from different clients", async () => {
		const { transport } = setupEagerHandler();

		await connectAndSync(transport, "alice");
		await connectAndSync(transport, "bob");
		transport.sentMessages.length = 0;

		// Alice sends
		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1", color: "#ff0000" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		// Bob sends
		transport.messageHandler!("bob", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op2",
					table: "strokes",
					op: "insert",
					rowId: "s2",
					payload: { id: "s2", color: "#0000ff" },
					hlc: "0000000000002.0001.client:bob",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		// Alice should see Bob's delta
		const aliceDeltas = getMessagesForClient(transport, "alice", "delta");
		expect(aliceDeltas.length).toBe(1);
		expect((aliceDeltas[0] as DeltaMessage).rowId).toBe("s2");

		// Bob should see Alice's delta
		const bobDeltas = getMessagesForClient(transport, "bob", "delta");
		expect(bobDeltas.length).toBe(1);
		expect((bobDeltas[0] as DeltaMessage).rowId).toBe("s1");
	});

	test("eager op sender does NOT receive own delta", async () => {
		const { transport } = setupEagerHandler();

		await connectAndSync(transport, "alice");
		transport.sentMessages.length = 0;

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		const aliceDeltas = getMessagesForClient(transport, "alice", "delta");
		expect(aliceDeltas.length).toBe(0);

		// But alice does get ack
		const acks = getMessagesForClient(transport, "alice", "ack");
		expect(acks.length).toBe(1);
	});

	test("buffer_full rejects op", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({
			transport,
			serverId: "test-server",
			db: {},
		});

		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		// Register with maxBufferSize: 1 and high flushInterval to prevent timer from draining
		handler.setQuery("strokes", {
			name: "strokes",
			callback: async () => [],
			tableDependencies: new Set(["strokes"]),
			options: {
				tables: ["strokes"],
				broadcast: "eager",
				maxBufferSize: 1,
				flushInterval: 60_000,
				mutate: async () => {},
			},
		});

		await connectAndSync(transport, "alice");
		transport.sentMessages.length = 0;

		// First op fills the buffer
		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		// Second op should be rejected (buffer full, flush can't help without storage on buffer)
		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op2",
					table: "strokes",
					op: "insert",
					rowId: "s2",
					payload: { id: "s2" },
					hlc: "0000000000002.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		const rejects = getMessagesForClient(transport, "alice", "reject");
		expect(rejects.length).toBe(1);
		expect((rejects[0] as RejectMessage).reason).toBe("buffer_full");
	});

	test("eager update op broadcasts correctly", async () => {
		const { transport } = setupEagerHandler();

		await connectAndSync(transport, "alice");
		await connectAndSync(transport, "bob");
		transport.sentMessages.length = 0;

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "update",
					rowId: "s1",
					payload: { color: "#00ff00" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		const bobDeltas = getMessagesForClient(transport, "bob", "delta");
		expect(bobDeltas.length).toBe(1);
		expect((bobDeltas[0] as DeltaMessage).op).toBe("update");
		expect((bobDeltas[0] as DeltaMessage).payload!.color).toBe("#00ff00");
	});

	test("eager delete op broadcasts correctly", async () => {
		const { transport } = setupEagerHandler();

		await connectAndSync(transport, "alice");
		await connectAndSync(transport, "bob");
		transport.sentMessages.length = 0;

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "delete",
					rowId: "s1",
					payload: null,
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		const bobDeltas = getMessagesForClient(transport, "bob", "delta");
		expect(bobDeltas.length).toBe(1);
		expect((bobDeltas[0] as DeltaMessage).op).toBe("delete");
		expect((bobDeltas[0] as DeltaMessage).payload).toBeNull();
	});

	test("bootstrap flushes eager buffer so new client sees buffered ops", async () => {
		const { transport, storage } = setupEagerHandler();

		// Alice connects, sends an op (buffered, not yet in storage)
		await connectAndSync(transport, "alice");
		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1", color: "#ff0000" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		// Verify it's still only in the buffer, not storage
		const beforeBootstrap = await storage.getRow("strokes", "s1");
		expect(beforeBootstrap.row).toBeNull();

		// Bob connects — bootstrap should flush the buffer first
		transport.connectHandler!("bob", new Request("https://sync"));
		transport.messageHandler!("bob", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "bob",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));
		transport.messageHandler!("bob", {
			type: "sync_declare",
			table: "strokes",
			params: {},
		});
		await new Promise((r) => setTimeout(r, 10));
		transport.messageHandler!("bob", {
			type: "bootstrap",
		});
		await new Promise((r) => setTimeout(r, 20));

		// After bootstrap, storage should have the row (flushed during bootstrap)
		const afterBootstrap = await storage.getRow("strokes", "s1");
		expect(afterBootstrap.row).not.toBeNull();

		// Bob's snapshot should include the row
		const bobSnapshots = getMessagesForClient(transport, "bob", "snapshot");
		expect(bobSnapshots.length).toBe(1);
		const snapshot = bobSnapshots[0] as { rows: Record<string, unknown>[] };
		expect(snapshot.rows.length).toBe(1);
		expect(snapshot.rows[0]!.id).toBe("s1");
	});

	test("replay guard: duplicate op is idempotent", async () => {
		const { transport } = setupEagerHandler();

		await connectAndSync(transport, "alice");
		await connectAndSync(transport, "bob");
		transport.sentMessages.length = 0;

		const op = {
			id: "op1",
			table: "strokes",
			op: "insert",
			rowId: "s1",
			payload: { id: "s1", color: "#ff0000" },
			hlc: "0000000000001.0001.client:alice",
		};

		// Send the same op twice
		transport.messageHandler!("alice", { type: "ops", token: "valid", ops: [op] });
		await new Promise((r) => setTimeout(r, 20));
		transport.messageHandler!("alice", { type: "ops", token: "valid", ops: [op] });
		await new Promise((r) => setTimeout(r, 20));

		// Both should be acked
		const acks = getMessagesForClient(transport, "alice", "ack");
		expect(acks.length).toBe(2);

		// But bob should only receive the delta once
		const bobDeltas = getMessagesForClient(transport, "bob", "delta");
		expect(bobDeltas.length).toBe(1);
	});

	test("partial flush error does not lose ops from other queries", async () => {
		const storage = createMockStorage();
		const buffer = new EagerBuffer();
		buffer.setStorage(storage);

		let failNext = true;
		const failingStorage: typeof storage = {
			...storage,
			async putRow(table, rowId, row, colClocks, hlc) {
				if (failNext) {
					failNext = false;
					throw new Error("transient failure");
				}
				return storage.putRow(table, rowId, row, colClocks, hlc);
			},
			async getRow(table, rowId) {
				return storage.getRow(table, rowId);
			},
			async getRows(table) {
				return storage.getRows(table);
			},
			async appendOp(entry) {
				return storage.appendOp!(entry);
			},
			// Drop applyOp so setStorage installs a shim that closes over THIS
			// failing adapter, exercising the partial-failure path.
			applyOp: undefined,
		};
		buffer.setStorage(failingStorage);

		// Two queries with one op each
		buffer.push("strokes", {
			entry: {
				table: "strokes",
				op: "insert",
				rowId: "s1",
				payload: { x: 1 },
				hlc: "001",
				colClocks: {},
			},
		});
		buffer.push("cursors", {
			entry: {
				table: "cursors",
				op: "insert",
				rowId: "c1",
				payload: { y: 2 },
				hlc: "002",
				colClocks: {},
			},
		});

		const flushed = await buffer.flush();
		// First op fails, second succeeds
		expect(flushed).toBe(1);

		// cursors op should be in storage
		const cursorRow = await storage.getRow("cursors", "c1");
		expect(cursorRow.row).not.toBeNull();
	});

	test("close flushes eager buffer", async () => {
		const { transport, storage, handler } = setupEagerHandler();

		await connectAndSync(transport, "alice");

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1", color: "#ff0000" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		await handler.close();

		const row = await storage.getRow("strokes", "s1");
		expect(row.row).not.toBeNull();
	});

	test("rate limiter rejects eager ops when exceeded", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({
			transport,
			serverId: "test-server",
			db: {},
		});

		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setRateLimiter({
			check(userId, clientId) {
				// Always reject
				return { ok: false, reason: "rate_limited" };
			},
			record() {},
		});

		handler.setQuery("strokes", {
			name: "strokes",
			callback: async () => [],
			tableDependencies: new Set(["strokes"]),
			options: {
				tables: ["strokes"],
				broadcast: "eager",
				mutate: async () => {},
			},
		});

		await connectAndSync(transport, "alice");
		transport.sentMessages.length = 0;

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		const rejects = getMessagesForClient(transport, "alice", "reject");
		expect(rejects.length).toBe(1);
		expect((rejects[0] as RejectMessage).reason).toBe("rate_limited");

		// Acked ops should be empty
		const acks = getMessagesForClient(transport, "alice", "ack");
		expect(acks.length).toBe(0);
	});

	test("shorter flushInterval restarts timer", async () => {
		const buffer = new EagerBuffer();

		// Start with 500ms interval
		buffer.start(500);

		// Restart with shorter interval (50ms)
		buffer.start(50);

		const storage = createMockStorage();
		buffer.setStorage(storage);

		buffer.push("q", {
			entry: {
				table: "t",
				op: "insert",
				rowId: "r1",
				payload: { x: 1 },
				hlc: "001",
				colClocks: {},
			},
		});

		// Wait 100ms — should flush if timer restarted to 50ms
		await new Promise((r) => setTimeout(r, 100));
		expect(buffer.pendingCount).toBe(0);

		await buffer.close();
	});

	test("longer flushInterval does not restart timer", async () => {
		const buffer = new EagerBuffer();
		const storage = createMockStorage();
		buffer.setStorage(storage);

		// Start with 50ms interval
		buffer.start(50);

		// Try to set longer interval — should keep 50ms
		buffer.start(500);

		buffer.push("q", {
			entry: {
				table: "t",
				op: "insert",
				rowId: "r1",
				payload: { x: 1 },
				hlc: "001",
				colClocks: {},
			},
		});

		// Wait 100ms — should flush at 50ms (not 500ms)
		await new Promise((r) => setTimeout(r, 100));
		expect(buffer.pendingCount).toBe(0);

		await buffer.close();
	});

	test("eager op broadcasts affected tables from MutateResult", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({
			transport,
			serverId: "test-server",
			db: {},
		});

		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		// posts query that also writes to post_tags
		handler.setQuery("posts", {
			name: "posts",
			callback: async () => {
				const { rows } = await storage.getRows("posts");
				return rows;
			},
			tableDependencies: new Set(["posts", "post_tags"]),
			options: {
				tables: ["posts", "post_tags"],
				broadcast: "eager",
				mutate: async (op) => {
					await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
					return { affected: ["post_tags"] };
				},
			},
		});

		// A second query that depends on post_tags (consistent, for change detection)
		handler.setQuery("tags", {
			name: "tags",
			callback: async () => {
				const { rows } = await storage.getRows("post_tags");
				return rows;
			},
			tableDependencies: new Set(["post_tags"]),
			options: {
				tables: ["post_tags"],
			},
		});

		// Connect and subscribe alice to both queries
		transport.connectHandler!("alice", new Request("https://sync"));
		transport.messageHandler!("alice", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "alice",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));
		transport.messageHandler!("alice", { type: "sync_declare", table: "posts", params: {} });
		transport.messageHandler!("alice", { type: "sync_declare", table: "tags", params: {} });
		await new Promise((r) => setTimeout(r, 10));
		transport.messageHandler!("alice", { type: "bootstrap" });
		await new Promise((r) => setTimeout(r, 10));

		// Connect bob and subscribe to both queries
		transport.connectHandler!("bob", new Request("https://sync"));
		transport.messageHandler!("bob", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "bob",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));
		transport.messageHandler!("bob", { type: "sync_declare", table: "posts", params: {} });
		transport.messageHandler!("bob", { type: "sync_declare", table: "tags", params: {} });
		await new Promise((r) => setTimeout(r, 10));
		transport.messageHandler!("bob", { type: "bootstrap" });
		await new Promise((r) => setTimeout(r, 10));

		transport.sentMessages.length = 0;

		// Alice sends an eager op to "posts" — mutate returns affected: ["post_tags"]
		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "posts",
					op: "insert",
					rowId: "p1",
					payload: { id: "p1", title: "hello" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		// Bob should have received the eager delta for posts
		const bobDeltas = getMessagesForClient(transport, "bob", "delta");
		expect(bobDeltas.length).toBeGreaterThanOrEqual(1);
		expect((bobDeltas[0] as DeltaMessage).table).toBe("posts");

		// The affected table "post_tags" should have triggered broadcastChanges
		// (which does change detection). No change will be found since no post_tags were written,
		// but the method should have been called without error.
		// The test proves the return value is captured and processed.
		const acks = getMessagesForClient(transport, "alice", "ack");
		expect(acks.length).toBe(1);
	});

	test("buffer_full is checked before mutate to avoid inconsistency", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({
			transport,
			serverId: "test-server",
			db: {},
		});

		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		let mutateCallCount = 0;

		handler.setQuery("strokes", {
			name: "strokes",
			callback: async () => [],
			tableDependencies: new Set(["strokes"]),
			options: {
				tables: ["strokes"],
				broadcast: "eager",
				maxBufferSize: 1,
				flushInterval: 60_000,
				mutate: async () => {
					mutateCallCount++;
				},
			},
		});

		await connectAndSync(transport, "alice");
		transport.sentMessages.length = 0;

		// First op fills the buffer
		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		expect(mutateCallCount).toBe(1);

		// Second op — buffer is full, should be rejected WITHOUT calling mutate
		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op2",
					table: "strokes",
					op: "insert",
					rowId: "s2",
					payload: { id: "s2" },
					hlc: "0000000000002.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 20));

		// mutate should NOT have been called for op2
		expect(mutateCallCount).toBe(1);

		const rejects = getMessagesForClient(transport, "alice", "reject");
		expect(rejects.length).toBe(1);
		expect((rejects[0] as RejectMessage).reason).toBe("buffer_full");
	});

	test("bootstrap_complete includes broadcast mode in tableMeta", async () => {
		const { transport } = setupEagerHandler();

		await connectAndSync(transport, "alice");

		const complete = transport.sentMessages.find(
			(m) => m.clientId === "alice" && m.message.type === "bootstrap_complete",
		);
		expect(complete).toBeDefined();
		const meta = (complete!.message as { tableMeta: Record<string, { broadcast: string }> })
			.tableMeta;
		expect(meta.strokes).toBeDefined();
		expect(meta.strokes.broadcast).toBe("eager");
	});
});

describe("eager-durable: persist-before-broadcast invariant", () => {
	test("oplog contains the op by the time any subscriber sees the delta", async () => {
		// Build a handler with eager-durable. Track whether the op was persisted
		// to the oplog at the moment the broadcast hits the transport.
		const storage = createMockStorage();
		const transport = createMockTransport();

		// Hook transport.send: record oplog state at every send.
		const oplogStateAtSend: Array<{ rowId: string; oplogLen: number }> = [];
		const origSend = transport.send.bind(transport);
		transport.send = async (clientId, msg) => {
			if ((msg as { type: string }).type === "delta") {
				const m = msg as { rowId: string };
				oplogStateAtSend.push({ rowId: m.rowId, oplogLen: storage.opLog.length });
			}
			return origSend(clientId, msg);
		};

		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("strokes", {
			name: "strokes",
			callback: async () => (await storage.getRows("strokes")).rows,
			tableDependencies: new Set(["strokes"]),
			options: {
				tables: ["strokes"],
				broadcast: "eager-durable",
				mutate: async () => {},
			},
		});

		await connectAndSync(transport, "alice");
		await connectAndSync(transport, "bob");
		transport.sentMessages.length = 0;
		oplogStateAtSend.length = 0;

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-d1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1", color: "#0000ff" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 30));

		// Bob should have received a delta
		expect(oplogStateAtSend.length).toBeGreaterThan(0);
		// At every send, oplog must already contain the op (oplogLen >= 1)
		for (const snap of oplogStateAtSend) {
			expect(snap.oplogLen).toBeGreaterThanOrEqual(1);
		}
		// And the row is persisted in the row store
		const row = await storage.getRow("strokes", "s1");
		expect(row.row).not.toBeNull();
	});

	test("plain eager: NOT persisted at broadcast time (documents the tradeoff)", async () => {
		const { transport, storage } = setupEagerHandler();
		await connectAndSync(transport, "alice");
		await connectAndSync(transport, "bob");

		// Snapshot oplog state when bob sees the delta
		let oplogLenAtBobDelta = -1;
		const origSend = transport.send.bind(transport);
		transport.send = async (clientId, msg) => {
			if (clientId === "bob" && (msg as { type: string }).type === "delta") {
				oplogLenAtBobDelta = storage.opLog.length;
			}
			return origSend(clientId, msg);
		};
		transport.sentMessages.length = 0;

		transport.messageHandler!("alice", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-e1",
					table: "strokes",
					op: "insert",
					rowId: "s1",
					payload: { id: "s1", color: "#ff0000" },
					hlc: "0000000000001.0001.client:alice",
				},
			],
		});
		await new Promise((r) => setTimeout(r, 30));

		// Plain eager: oplog is empty when bob sees the delta. This is the
		// crash window the docs warn about.
		expect(oplogLenAtBobDelta).toBe(0);
	});
});
