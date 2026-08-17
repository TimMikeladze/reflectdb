import { describe, expect, test, beforeEach } from "bun:test";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter, OpLogEntry } from "../../src/server/handler.ts";
import { createMockTransport } from "./helpers.ts";
import { packHlc } from "../../src/core/hlc.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type { DeltaMessage, SnapshotMessage } from "../../src/core/types.ts";

function createMockStorageWithOpLog(): StorageAdapter & { opLog: OpLogEntry[] } {
	const store = new Map<
		string,
		{ row: Record<string, unknown>; colClocks: Record<string, string>; hlc: string }
	>();
	const opLog: OpLogEntry[] = [];

	return {
		opLog,
		async getRow(table, rowId) {
			const entry = store.get(`${table}:${rowId}`);
			if (!entry) return { row: null, rowHlc: null, colClocks: {} };
			return { row: entry.row, rowHlc: entry.hlc, colClocks: entry.colClocks };
		},
		async putRow(table, rowId, row, colClocks, hlc) {
			if (row === null) {
				store.delete(`${table}:${rowId}`);
			} else {
				store.set(`${table}:${rowId}`, { row, colClocks, hlc });
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
		async appendOp(entry) {
			opLog.push(entry);
		},
		async getOpsSince(since, tables) {
			return opLog.filter((e) => e.hlc > since && tables.includes(e.table));
		},
		async deleteOpsBefore(hlc) {
			const before = opLog.length;
			const kept = opLog.filter((e) => e.hlc >= hlc);
			opLog.length = 0;
			opLog.push(...kept);
			return before - kept.length;
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

describe("Resume with delta catch-up", () => {
	beforeEach(() => {});

	test("resume re-executes queries for changed tables and sends snapshots", async () => {
		const transport = createMockTransport();
		const storage = createMockStorageWithOpLog();

		// Simulate current DB state (after all ops applied)
		const postsDb = [
			{ id: "r1", title: "a2" },
			{ id: "r2", title: "b" },
		];

		const handler = new MessageHandler({
			transport,
			serverId: "test",
			db: {},
		});
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: () => postsDb,
			tableDependencies: new Set(["posts"]),
			options: { tables: ["posts"], conflict: "lww" },
		});

		// Pre-populate op log with entries (tells resume which tables changed)
		const hlc1 = packHlc({ ms: 1000, counter: 0, nodeId: "server:1" });
		const hlc2 = packHlc({ ms: 2000, counter: 0, nodeId: "server:1" });
		const hlc3 = packHlc({ ms: 3000, counter: 0, nodeId: "server:1" });

		storage.opLog.push(
			{
				table: "posts",
				op: "insert",
				rowId: "r1",
				payload: { title: "a" },
				hlc: hlc1,
				colClocks: { _row: hlc1 },
			},
			{
				table: "posts",
				op: "insert",
				rowId: "r2",
				payload: { title: "b" },
				hlc: hlc2,
				colClocks: { _row: hlc2 },
			},
			{
				table: "posts",
				op: "update",
				rowId: "r1",
				payload: { title: "a2" },
				hlc: hlc3,
				colClocks: { _row: hlc3 },
			},
		);

		// Connect and auth
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();

		// Subscribe
		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		await tick();

		transport.sentMessages.length = 0;

		// Resume since hlc1 — should re-execute query and send snapshot
		transport.messageHandler!("client1", { type: "resume", since: hlc1 });
		await tick();

		// Now sends snapshots (query re-execution) instead of raw deltas (tenant-safe)
		const snapshots = transport.sentMessages.filter((m) => m.message.type === "snapshot");
		expect(snapshots.length).toBe(1);
		const snapshot = snapshots[0]!.message as SnapshotMessage;
		expect(snapshot.table).toBe("posts");
		expect(snapshot.rows).toHaveLength(2);
		expect(snapshot.rows.find((r) => r.id === "r1")!.title).toBe("a2");
		expect(snapshot.rows.find((r) => r.id === "r2")!.title).toBe("b");

		const complete = transport.sentMessages.find((m) => m.message.type === "resume_complete");
		expect(complete).toBeDefined();
	});

	test("resume skips queries with no changed dependencies", async () => {
		const transport = createMockTransport();
		const storage = createMockStorageWithOpLog();

		const handler = new MessageHandler({
			transport,
			serverId: "test",
			db: {},
		});
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: () => [{ id: "p1", title: "hello" }],
			tableDependencies: new Set(["posts"]),
			options: { tables: ["posts"], conflict: "lww" },
		});
		handler.setQuery("comments", {
			name: "comments",
			callback: () => [{ id: "c1", text: "hi" }],
			tableDependencies: new Set(["comments"]),
			options: { tables: ["comments"], conflict: "lww" },
		});

		// Only "posts" table has ops since the watermark
		const hlc1 = packHlc({ ms: 1000, counter: 0, nodeId: "server:1" });
		storage.opLog.push({
			table: "posts",
			op: "insert",
			rowId: "p1",
			payload: { title: "hello" },
			hlc: hlc1,
			colClocks: {},
		});

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();
		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		transport.messageHandler!("client1", { type: "sync_declare", table: "comments" });
		await tick();
		transport.sentMessages.length = 0;

		const staleHlc = packHlc({ ms: 500, counter: 0, nodeId: "server:1" });
		transport.messageHandler!("client1", { type: "resume", since: staleHlc });
		await tick();

		// Only "posts" snapshot — "comments" had no changes
		const snapshots = transport.sentMessages.filter((m) => m.message.type === "snapshot");
		expect(snapshots.length).toBe(1);
		expect((snapshots[0]!.message as SnapshotMessage).table).toBe("posts");
	});

	test("resume with empty op log sends resume_complete with no deltas", async () => {
		const transport = createMockTransport();
		const storage: StorageAdapter = {
			async getRow() {
				return { row: null, rowHlc: null, colClocks: {} };
			},
			async putRow() {},
			async getRows() {
				return { rows: [], colClocks: {} };
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

		const handler = new MessageHandler({ transport, serverId: "test" });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();

		transport.sentMessages.length = 0;

		transport.messageHandler!("client1", {
			type: "resume",
			since: "0000000000000001000.0000.server:1",
		});
		await tick();

		const complete = transport.sentMessages.find((m) => m.message.type === "resume_complete");
		expect(complete).toBeDefined();
		const deltas = transport.sentMessages.filter((m) => m.message.type === "delta");
		expect(deltas.length).toBe(0);
	});
});

describe("Op log append on accepted ops", () => {
	beforeEach(() => {});

	test("accepted op is appended to op log", async () => {
		const transport = createMockTransport();
		const storage = createMockStorageWithOpLog();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: () => {},
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

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();

		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		await tick();

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-log-1",
					table: "posts",
					op: "insert",
					rowId: "rl-1",
					payload: { title: "logged" },
					hlc,
				},
			],
		});
		await tick();

		expect(storage.opLog.length).toBe(1);
		expect(storage.opLog[0]!.table).toBe("posts");
		expect(storage.opLog[0]!.rowId).toBe("rl-1");
	});
});

describe("Compaction", () => {
	beforeEach(() => {});

	test("runCompaction deletes old op log entries", async () => {
		const transport = createMockTransport();
		const storage = createMockStorageWithOpLog();
		const handler = new MessageHandler({ transport, serverId: "test" });
		handler.setStorage(storage);

		const oldHlc = packHlc({ ms: 1000, counter: 0, nodeId: "s:1" });
		const newHlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "s:1" });

		storage.opLog.push(
			{ table: "posts", op: "insert", rowId: "r1", payload: {}, hlc: oldHlc, colClocks: {} },
			{ table: "posts", op: "insert", rowId: "r2", payload: {}, hlc: newHlc, colClocks: {} },
		);

		// Compact ops older than 1 hour
		const deleted = await handler.runCompaction(60 * 60 * 1000);
		expect(deleted).toBe(1);
		expect(storage.opLog.length).toBe(1);
		expect(storage.opLog[0]!.rowId).toBe("r2");
	});

	test("runCompaction returns 0 when no op log support", async () => {
		const transport = createMockTransport();
		const handler = new MessageHandler({ transport, serverId: "test" });
		// No storage set
		const deleted = await handler.runCompaction(60 * 60 * 1000);
		expect(deleted).toBe(0);
	});

	test("resume with stale watermark after compaction sends resume_rejected", async () => {
		const transport = createMockTransport();
		const storage = createMockStorageWithOpLog();
		const handler = new MessageHandler({ transport, serverId: "test" });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: () => {},
			tableDependencies: new Set(["posts"]),
			options: { tables: ["posts"], conflict: "lww" },
		});

		// Populate op log with old and new entries
		const oldHlc = packHlc({ ms: 1000, counter: 0, nodeId: "s:1" });
		const newHlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "s:1" });
		storage.opLog.push(
			{ table: "posts", op: "insert", rowId: "r1", payload: {}, hlc: oldHlc, colClocks: {} },
			{ table: "posts", op: "insert", rowId: "r2", payload: {}, hlc: newHlc, colClocks: {} },
		);

		// Run compaction — deletes the old entry
		const deleted = await handler.runCompaction(60 * 60 * 1000);
		expect(deleted).toBe(1);

		// Connect and subscribe
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();
		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		await tick();
		transport.sentMessages.length = 0;

		// Resume with a watermark older than the compaction cutoff
		transport.messageHandler!("client1", { type: "resume", since: oldHlc });
		await tick();

		const rejected = transport.sentMessages.find((m) => m.message.type === "resume_rejected");
		expect(rejected).toBeDefined();
		expect((rejected!.message as { reason: string }).reason).toBe("compacted");

		// Should NOT have sent any deltas
		const deltas = transport.sentMessages.filter((m) => m.message.type === "delta");
		expect(deltas.length).toBe(0);
	});

	test("compaction watermark is loaded from storage on fresh handler", async () => {
		const transport = createMockTransport();
		const metaStore = new Map<string, string>();
		const storage: StorageAdapter = {
			...createMockStorageWithOpLog(),
			async getMeta(key) {
				return metaStore.get(key) ?? null;
			},
			async setMeta(key, value) {
				metaStore.set(key, value);
			},
		};

		// Simulate a previously-persisted compaction cutoff
		const cutoffHlc = String(Date.now() - 1000).padStart(19, "0") + ".9999.compaction";
		metaStore.set("compactionCutoff", cutoffHlc);

		const handler = new MessageHandler({ transport, serverId: "test" });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: () => {},
			tableDependencies: new Set(["posts"]),
			options: { tables: ["posts"], conflict: "lww" },
		});

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();
		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		await tick();
		transport.sentMessages.length = 0;

		// Resume with a watermark older than the persisted cutoff
		const staleHlc = packHlc({ ms: 1000, counter: 0, nodeId: "s:1" });
		transport.messageHandler!("client1", { type: "resume", since: staleHlc });
		await tick();

		const rejected = transport.sentMessages.find((m) => m.message.type === "resume_rejected");
		expect(rejected).toBeDefined();
		expect((rejected!.message as { reason: string }).reason).toBe("compacted");
	});

	test("safety floor: minOpAge below 30s is clamped, recent ops not deleted", async () => {
		const transport = createMockTransport();
		const storage = createMockStorageWithOpLog();
		const handler = new MessageHandler({ transport, serverId: "test" });
		handler.setStorage(storage);

		// All ops are 5 seconds old — within the 30s safety floor.
		const recentHlc = packHlc({
			ms: Date.now() - 5_000,
			counter: 0,
			nodeId: "s:1",
		});
		storage.opLog.push({
			table: "posts",
			op: "insert",
			rowId: "r1",
			payload: {},
			hlc: recentHlc,
			colClocks: {},
		});

		// Caller asks for aggressive 1ms — handler must clamp to 30s floor.
		const deleted = await handler.runCompaction(1);
		expect(deleted).toBe(0);
		expect(storage.opLog.length).toBe(1);
	});

	test("monotonic guard: cutoff cannot move backwards", async () => {
		const transport = createMockTransport();
		const metaStore = new Map<string, string>();
		const storage: StorageAdapter = {
			...createMockStorageWithOpLog(),
			async getMeta(key) {
				return metaStore.get(key) ?? null;
			},
			async setMeta(key, value) {
				metaStore.set(key, value);
			},
		};
		const handler = new MessageHandler({ transport, serverId: "test" });
		handler.setStorage(storage);

		// Pre-set a recent cutoff (further forward than any cutoff a caller could
		// generate now — e.g. a future timestamp simulating a bug or clock skew).
		const futureCutoff = String(Date.now() + 60_000).padStart(19, "0") + ".9999.compaction";
		metaStore.set("compactionCutoff", futureCutoff);

		// Add an old op
		storage.opLog.push({
			table: "posts",
			op: "insert",
			rowId: "r1",
			payload: {},
			hlc: packHlc({ ms: 1000, counter: 0, nodeId: "s:1" }),
			colClocks: {},
		});

		// runCompaction would generate a cutoff < futureCutoff. Must refuse.
		const deleted = await handler.runCompaction(60 * 60 * 1000);
		expect(deleted).toBe(0);
		// Op log untouched
		expect(storage.opLog.length).toBe(1);
		// Cutoff in storage unchanged
		expect(metaStore.get("compactionCutoff")).toBe(futureCutoff);
	});
});
