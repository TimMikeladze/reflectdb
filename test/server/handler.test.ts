import { describe, expect, test, beforeEach } from "bun:test";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { createMockTransport } from "./helpers.ts";
import { packHlc } from "../../src/core/hlc.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type {
	ServerMessage,
	HelloAckMessage,
	HelloRejectMessage,
	BootstrapCompleteMessage,
	AckMessage,
	DeltaMessage,
	RejectMessage,
	EphemeralEvent,
} from "../../src/core/types.ts";

/**
 * Poll until `predicate` holds. Preferred over a fixed sleep for anything
 * gated on real timers: Windows floors short `setTimeout` delays to the
 * system tick, so a wait tuned on macOS/Linux expires before the work lands.
 */
async function waitFor(
	predicate: () => boolean,
	{ timeout = 4000, interval = 10 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
	const deadline = performance.now() + timeout;
	while (!predicate()) {
		if (performance.now() > deadline) return;
		await new Promise((r) => setTimeout(r, interval));
	}
}

function createMockStorage(): StorageAdapter {
	const store = new Map<
		string,
		{ row: Record<string, unknown>; colClocks: Record<string, string>; hlc: string }
	>();

	return {
		async getRow(table: string, rowId: string) {
			const key = `${table}:${rowId}`;
			const entry = store.get(key);
			if (!entry) {
				return { row: null, rowHlc: null, colClocks: {} };
			}
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
		async getRows(table, filter) {
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

function setupHandler() {
	const transport = createMockTransport();
	const storage = createMockStorage();
	const handler = new MessageHandler({
		transport,
		serverId: "test-server",
		db: {},
	});

	handler.setStorage(storage);
	handler.setAuth(async (req) => {
		const token = req.headers.get("authorization")?.replace("Bearer ", "");
		if (token === "valid") {
			return { userId: "user1" };
		}
		throw new Error("Invalid token");
	});
	handler.setQuery("posts", {
		name: "posts",
		callback: async () => {
			const { rows } = await storage.getRows("posts");
			return rows;
		},
		tableDependencies: new Set(["posts"]),
		options: {
			tables: ["posts"],
			conflict: "lww",
			serverSet: { orgId: "org-server" },
			readonly: [],
			mutate: async (op) => {
				if (op.type === "delete") {
					await storage.putRow("posts", op.rowId, null, {}, op.hlc);
				} else {
					await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
				}
			},
		},
	});

	return { transport, handler, storage };
}

async function connectAndAuth(transport: ReturnType<typeof createMockTransport>) {
	// Trigger connect
	transport.connectHandler!("client1", new Request("https://sync"));

	// Send hello
	transport.messageHandler!("client1", {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId: "client1",
		token: "valid",
	});

	// Wait for async handler
	await new Promise((r) => setTimeout(r, 10));
}

describe("MessageHandler", () => {
	beforeEach(() => {});

	test("hello with valid token sends hello_ack", async () => {
		const { transport } = setupHandler();
		await connectAndAuth(transport);

		const ack = transport.sentMessages.find((m) => m.message.type === "hello_ack");
		expect(ack).toBeDefined();
		expect(ack!.clientId).toBe("client1");
		const ackMsg = ack!.message as HelloAckMessage;
		expect(ackMsg.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(ackMsg.serverId).toBe("test-server");
	});

	test("hello with invalid token sends hello_reject", async () => {
		const { transport } = setupHandler();
		transport.connectHandler!("client1", new Request("https://sync"));

		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "invalid",
		});
		await new Promise((r) => setTimeout(r, 10));

		const reject = transport.sentMessages.find((m) => m.message.type === "hello_reject");
		expect(reject).toBeDefined();
	});

	test("hello with wrong protocol version sends hello_reject", async () => {
		const { transport } = setupHandler();
		transport.connectHandler!("client1", new Request("https://sync"));

		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: 999,
			clientId: "client1",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));

		const reject = transport.sentMessages.find((m) => m.message.type === "hello_reject");
		expect(reject).toBeDefined();
		expect((reject!.message as HelloRejectMessage).supported).toEqual([PROTOCOL_VERSION]);
	});

	test("sync_declare subscribes client to table", async () => {
		const { transport, handler } = setupHandler();
		await connectAndAuth(transport);

		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		const session = handler.getSessions().get("client1");
		expect(session!.subscriptions.has("posts")).toBe(true);
	});

	test("unsync removes subscription", async () => {
		const { transport, handler } = setupHandler();
		await connectAndAuth(transport);

		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.messageHandler!("client1", {
			type: "unsync",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		const session = handler.getSessions().get("client1");
		expect(session!.subscriptions.has("posts")).toBe(false);
	});

	test("bootstrap sends snapshots + bootstrap_complete", async () => {
		const { transport } = setupHandler();
		await connectAndAuth(transport);

		// Subscribe to posts
		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.sentMessages.length = 0; // clear

		transport.messageHandler!("client1", {
			type: "bootstrap",
		});
		await new Promise((r) => setTimeout(r, 10));

		const snapshot = transport.sentMessages.find((m) => m.message.type === "snapshot");
		expect(snapshot).toBeDefined();

		const complete = transport.sentMessages.find((m) => m.message.type === "bootstrap_complete");
		expect(complete).toBeDefined();
		const meta = (complete!.message as BootstrapCompleteMessage).tableMeta;
		expect(meta.posts).toBeDefined();
		expect(meta.posts.serverSet).toEqual(["orgId"]);
	});

	test("ops with valid insert gets ack", async () => {
		const { transport } = setupHandler();
		await connectAndAuth(transport);

		// Subscribe
		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.sentMessages.length = 0;

		const hlc = packHlc({
			ms: Date.now(),
			counter: 0,
			nodeId: "client:a",
		});

		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-1",
					table: "posts",
					op: "insert",
					rowId: "row-1",
					payload: { title: "hello" },
					hlc,
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		const ack = transport.sentMessages.find((m) => m.message.type === "ack");
		expect(ack).toBeDefined();
		expect((ack!.message as AckMessage).opIds).toEqual(["op-1"]);
	});

	test("ops applies serverSet enforcement", async () => {
		const { transport, storage } = setupHandler();
		await connectAndAuth(transport);

		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		const hlc = packHlc({
			ms: Date.now(),
			counter: 0,
			nodeId: "client:a",
		});

		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-2",
					table: "posts",
					op: "insert",
					rowId: "row-2",
					payload: { title: "hello", orgId: "client-org" },
					hlc,
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		// Verify stored row has server-set orgId
		const row = await storage.getRow("posts", "row-2");
		expect(row.row).toBeDefined();
		expect(row.row!.orgId).toBe("org-server");
	});

	test("ops resolves serverSet function values with auth context", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({
			transport,
			serverId: "test-server",
			db: {},
		});
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "alice" }));

		let capturedPayload: Record<string, unknown> | null = null;
		handler.setQuery("tasks", {
			name: "tasks",
			callback: async () => [],
			tableDependencies: new Set(["tasks"]),
			options: {
				tables: ["tasks"],
				conflict: "merge",
				serverSet: {
					createdBy: (ctx: { auth: { userId: string } }) => ctx.auth.userId,
					updatedAt: () => "2026-01-01T00:00:00Z",
				},
				readonly: ["createdAt", "createdBy"],
				mutate: async (op) => {
					capturedPayload = op.payload;
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
		await new Promise((r) => setTimeout(r, 10));

		transport.messageHandler!("client1", { type: "sync_declare", table: "tasks" });
		await new Promise((r) => setTimeout(r, 10));

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-fn",
					table: "tasks",
					op: "insert",
					rowId: "task-1",
					payload: { title: "Ship it", createdAt: "2026-01-01", createdBy: "client-value" },
					hlc,
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		// Verify the op was accepted
		const ack = transport.sentMessages.find((m) => m.message.type === "ack");
		expect(ack).toBeDefined();

		// Verify serverSet functions were resolved (not stored as functions)
		expect(capturedPayload).toBeDefined();
		expect(capturedPayload!.createdBy).toBe("alice"); // resolved from auth context
		expect(capturedPayload!.updatedAt).toBe("2026-01-01T00:00:00Z"); // resolved from no-arg function
		expect(typeof capturedPayload!.createdBy).toBe("string");
		expect(typeof capturedPayload!.updatedAt).toBe("string");

		// Verify readonly allowed createdAt on insert
		expect(capturedPayload!.createdAt).toBe("2026-01-01");
	});

	test("ops broadcasts delta to other subscribers", async () => {
		const { transport } = setupHandler();

		// Connect client1
		await connectAndAuth(transport);

		// Connect client2
		transport.connectHandler!("client2", new Request("https://sync"));
		transport.messageHandler!("client2", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client2",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));

		// Both subscribe to posts
		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		transport.messageHandler!("client2", {
			type: "sync_declare",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.sentMessages.length = 0;

		const hlc = packHlc({
			ms: Date.now(),
			counter: 0,
			nodeId: "client:a",
		});

		// client1 sends op
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-delta",
					table: "posts",
					op: "insert",
					rowId: "row-delta",
					payload: { title: "broadcast me" },
					hlc,
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		// client2 should receive delta
		const deltas = transport.sentMessages.filter(
			(m) => m.clientId === "client2" && m.message.type === "delta",
		);
		expect(deltas.length).toBe(1);
		const delta = deltas[0]!.message as DeltaMessage;
		expect(delta.table).toBe("posts");
		expect(delta.rowId).toBe("row-delta");

		// client1 should NOT receive delta (excluded)
		const selfDeltas = transport.sentMessages.filter(
			(m) => m.clientId === "client1" && m.message.type === "delta",
		);
		expect(selfDeltas.length).toBe(0);
	});

	test("ops with expired token sends reauth", async () => {
		const { transport, handler } = setupHandler();
		await connectAndAuth(transport);

		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.sentMessages.length = 0;

		// Send ops with invalid token
		transport.messageHandler!("client1", {
			type: "ops",
			token: "invalid",
			ops: [
				{
					id: "op-bad",
					table: "posts",
					op: "insert",
					rowId: "row-bad",
					payload: { title: "nope" },
					hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" }),
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		const reauth = transport.sentMessages.find((m) => m.message.type === "reauth");
		expect(reauth).toBeDefined();
	});

	test("ops to unregistered table rejects with outside_shape", async () => {
		const { transport } = setupHandler();
		await connectAndAuth(transport);

		transport.sentMessages.length = 0;

		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-unknown",
					table: "unknown_table",
					op: "insert",
					rowId: "row-1",
					payload: { foo: "bar" },
					hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" }),
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		const reject = transport.sentMessages.find((m) => m.message.type === "reject");
		expect(reject).toBeDefined();
		expect((reject!.message as RejectMessage).reason).toBe("outside_shape");
	});

	test("independent ops do not cascade-fail across batchIds", async () => {
		const { transport } = setupHandler();
		await connectAndAuth(transport);
		transport.sentMessages.length = 0;

		const goodHlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		const goodHlc2 = packHlc({ ms: Date.now() + 1, counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				// Independent op 1: invalid table → rejected
				{
					id: "bad",
					table: "unknown_table",
					op: "insert",
					rowId: "x",
					payload: {},
					hlc: goodHlc,
				},
				// Independent op 2: valid → must still be accepted
				{
					id: "good",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "ok" },
					hlc: goodHlc2,
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		const ack = transport.sentMessages.find((m) => m.message.type === "ack");
		expect(ack).toBeDefined();
		expect((ack!.message as AckMessage).opIds).toContain("good");
	});

	test("batch ops fail-fast within same batchId", async () => {
		const { transport } = setupHandler();
		await connectAndAuth(transport);
		transport.sentMessages.length = 0;

		const batchId = "batch-1";
		const baseHlc = Date.now();
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "b1",
					batchId,
					table: "unknown_table",
					op: "insert",
					rowId: "x",
					payload: {},
					hlc: packHlc({ ms: baseHlc, counter: 0, nodeId: "client:a" }),
				},
				{
					id: "b2",
					batchId,
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "ok" },
					hlc: packHlc({ ms: baseHlc + 1, counter: 0, nodeId: "client:a" }),
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		const rejects = transport.sentMessages.filter((m) => m.message.type === "reject");
		const rejectedIds = rejects.map((m) => (m.message as RejectMessage).opId);
		expect(rejectedIds).toContain("b1");
		expect(rejectedIds).toContain("b2");
	});

	test("disconnect removes session", async () => {
		const { transport, handler } = setupHandler();
		await connectAndAuth(transport);

		expect(handler.getSessions().size()).toBe(1);
		transport.disconnectHandler!("client1");
		expect(handler.getSessions().size()).toBe(0);
	});

	test("resume sends resume_complete", async () => {
		const { transport } = setupHandler();
		await connectAndAuth(transport);

		transport.sentMessages.length = 0;

		transport.messageHandler!("client1", {
			type: "resume",
			since: "0000000000000001000.0000.server:test",
		});
		await new Promise((r) => setTimeout(r, 10));

		const complete = transport.sentMessages.find((m) => m.message.type === "resume_complete");
		expect(complete).toBeDefined();
	});

	test("ephemeral messages broadcast to same room", async () => {
		const { transport, handler } = setupHandler();

		// Connect and subscribe both clients
		await connectAndAuth(transport);
		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.connectHandler!("client2", new Request("https://sync"));
		transport.messageHandler!("client2", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client2",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.messageHandler!("client2", {
			type: "sync_declare",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.sentMessages.length = 0;

		// Client1 sends ephemeral message (with a spoofed userId to test server enforcement)
		transport.messageHandler!("client1", {
			type: "ephemeral",
			key: "cursor",
			userId: "spoofed-user",
			data: { x: 100, y: 200 },
			ttlMs: 5000,
		});
		await new Promise((r) => setTimeout(r, 10));

		// Client2 should receive it with the AUTHENTICATED userId, not the spoofed one
		const ephemeralMsg = transport.sentMessages.find(
			(m) => m.clientId === "client2" && m.message.type === "ephemeral",
		);
		expect(ephemeralMsg).toBeDefined();
		const ephemeral = ephemeralMsg!.message as EphemeralEvent;
		expect(ephemeral.key).toBe("cursor");
		expect(ephemeral.userId).toBe("user1"); // from auth, not "spoofed-user"
		expect(ephemeral.clientId).toBe("client1");
		expect(ephemeral.data).toEqual({ x: 100, y: 200 });
		expect(ephemeral.ttlMs).toBe(5000);
	});

	test("ephemeral clamps absurd TTL to 24h cap", async () => {
		const { transport } = setupHandler();
		await connectAndAuth(transport);
		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		await new Promise((r) => setTimeout(r, 10));

		transport.connectHandler!("client2", new Request("https://sync"));
		transport.messageHandler!("client2", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client2",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));
		transport.messageHandler!("client2", { type: "sync_declare", table: "posts" });
		await new Promise((r) => setTimeout(r, 10));

		transport.sentMessages.length = 0;
		transport.messageHandler!("client1", {
			type: "ephemeral",
			key: "cursor",
			userId: "user1",
			data: {},
			ttlMs: Number.MAX_SAFE_INTEGER,
		});
		await new Promise((r) => setTimeout(r, 10));

		const msg = transport.sentMessages.find(
			(m) => m.clientId === "client2" && m.message.type === "ephemeral",
		);
		const e = msg!.message as EphemeralEvent;
		expect(e.ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
	});

	test("ephemeral manager cleans up on disconnect", async () => {
		const { transport, handler } = setupHandler();

		await connectAndAuth(transport);
		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		await new Promise((r) => setTimeout(r, 10));

		// Send ephemeral message
		transport.messageHandler!("client1", {
			type: "ephemeral",
			key: "cursor",
			userId: "user1",
			data: { x: 100 },
		});
		await new Promise((r) => setTimeout(r, 10));

		// Disconnect
		transport.disconnectHandler!("client1");
		await new Promise((r) => setTimeout(r, 10));

		// Ephemeral state should be cleaned up (no error on second disconnect)
		transport.disconnectHandler!("client1");
		expect(true).toBe(true); // If we got here, no error was thrown
	});
});

describe("Query error isolation", () => {
	beforeEach(() => {});

	test("broadcast skips subscriber when query throws (no ghost deletes)", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		let shouldThrow = false;

		const handler = new MessageHandler({
			transport,
			serverId: "test",
			db: {},
		});

		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: () => {
				if (shouldThrow) throw new Error("db connection lost");
				return storage.getRows("posts").then((r) => r.rows);
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

		// Connect two clients
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.connectHandler!("client2", new Request("https://sync"));
		transport.messageHandler!("client2", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client2",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));

		// Both subscribe
		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		transport.messageHandler!("client2", { type: "sync_declare", table: "posts" });
		await new Promise((r) => setTimeout(r, 10));

		// Bootstrap both
		transport.messageHandler!("client1", { type: "bootstrap" });
		transport.messageHandler!("client2", { type: "bootstrap" });
		await new Promise((r) => setTimeout(r, 10));

		// Client1 inserts a row
		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-pre",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "hello" },
					hlc,
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		// Verify client2 got the delta (cache now has r1)
		const preDelta = transport.sentMessages.filter(
			(m) => m.clientId === "client2" && m.message.type === "delta",
		);
		expect(preDelta.length).toBe(1);

		// Now make queries throw for client2's broadcast
		shouldThrow = true;
		transport.sentMessages.length = 0;

		// Client1 inserts another row — broadcast to client2 should skip (not send ghost deletes)
		const hlc2 = packHlc({ ms: Date.now() + 1, counter: 1, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-fail",
					table: "posts",
					op: "insert",
					rowId: "r2",
					payload: { title: "world" },
					hlc: hlc2,
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		// Client2 should NOT receive any deltas (especially no delete for r1)
		const client2Deltas = transport.sentMessages.filter(
			(m) => m.clientId === "client2" && m.message.type === "delta",
		);
		expect(client2Deltas.length).toBe(0);
	});
});

describe("Rate limiter crash isolation", () => {
	beforeEach(() => {});

	test("throwing rate limiter does not crash consistent path op", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({
			transport,
			serverId: "test",
			db: {},
		});

		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: () => storage.getRows("posts").then((r) => r.rows),
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

		// Set a rate limiter that throws
		handler.setRateLimiter({
			check() {
				throw new Error("rate limiter bug");
			},
			record() {},
		});

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		transport.messageHandler!("client1", { type: "bootstrap" });
		await new Promise((r) => setTimeout(r, 10));

		transport.sentMessages.length = 0;

		// Send an op — should succeed despite throwing rate limiter
		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-rate-crash",
					table: "posts",
					op: "insert",
					rowId: "rc1",
					payload: { title: "survived" },
					hlc,
				},
			],
		});
		await new Promise((r) => setTimeout(r, 10));

		const ack = transport.sentMessages.find((m) => m.message.type === "ack");
		expect(ack).toBeDefined();
		expect((ack!.message as AckMessage).opIds).toContain("op-rate-crash");
	});
});

describe("Replay detection (handler-level)", () => {
	test("duplicate op id is silently accepted (idempotent)", async () => {
		const transport = createMockTransport();
		// Create a storage that actually tracks ops for replay detection
		const recordedOps = new Set<string>();
		const baseStorage = createMockStorage();
		const storage: StorageAdapter = {
			...baseStorage,
			async reserveOp(opId: string) {
				if (recordedOps.has(opId)) return false;
				recordedOps.add(opId);
				return true;
			},
		};

		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: async () => (await storage.getRows("posts")).rows,
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
		await new Promise((r) => setTimeout(r, 10));
		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		transport.messageHandler!("client1", { type: "bootstrap" });
		await new Promise((r) => setTimeout(r, 10));
		transport.sentMessages.length = 0;

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		const ops = [
			{
				id: "dup-1",
				table: "posts",
				op: "insert" as const,
				rowId: "r1",
				payload: { title: "first" },
				hlc,
			},
		];

		// First send
		transport.messageHandler!("client1", { type: "ops", token: "valid", ops });
		await new Promise((r) => setTimeout(r, 10));

		// Second send (same op id)
		transport.messageHandler!("client1", { type: "ops", token: "valid", ops });
		await new Promise((r) => setTimeout(r, 10));

		// Both should be acked (second is silently accepted)
		const acks = transport.sentMessages.filter((m) => m.message.type === "ack");
		expect(acks.length).toBe(2);

		// No reject messages
		const rejects = transport.sentMessages.filter((m) => m.message.type === "reject");
		expect(rejects.length).toBe(0);
	});

	test("HA: shared atomic reserveOp prevents double-apply across instances", async () => {
		// Simulate two server instances sharing one storage. reserveOp is the
		// only atomic gate — if it weren't atomic, both would accept the same op.
		const sharedReserved = new Set<string>();
		const sharedRows = new Map<string, Record<string, unknown>>();
		let mutateCalls = 0;

		const makeSharedStorage = (): StorageAdapter => {
			const base = createMockStorage();
			return {
				...base,
				async reserveOp(opId: string) {
					// Atomic: single check-and-insert in one step.
					if (sharedReserved.has(opId)) return false;
					sharedReserved.add(opId);
					return true;
				},
				async putRow(table, rowId, row) {
					if (row === null) sharedRows.delete(`${table}:${rowId}`);
					else sharedRows.set(`${table}:${rowId}`, row);
				},
				async getRows() {
					return { rows: Array.from(sharedRows.values()), colClocks: {} };
				},
			};
		};

		const buildHandler = (serverId: string) => {
			const transport = createMockTransport();
			const storage = makeSharedStorage();
			const handler = new MessageHandler({ transport, serverId, db: {} });
			handler.setStorage(storage);
			handler.setAuth(async () => ({ userId: "user1" }));
			handler.setQuery("posts", {
				name: "posts",
				callback: async () => (await storage.getRows("posts")).rows,
				tableDependencies: new Set(["posts"]),
				options: {
					tables: ["posts"],
					conflict: "lww",
					mutate: async (op) => {
						mutateCalls++;
						if (op.type !== "delete") {
							await storage.putRow(
								"posts",
								op.rowId,
								{ ...op.payload, id: op.rowId },
								{},
								op.hlc,
							);
						}
					},
				},
			});
			return { transport, handler };
		};

		const a = buildHandler("server-A");
		const b = buildHandler("server-B");

		const connect = async (t: typeof a.transport, clientId: string) => {
			t.connectHandler!(clientId, new Request("https://sync"));
			t.messageHandler!(clientId, {
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				clientId,
				token: "valid",
			});
			await new Promise((r) => setTimeout(r, 10));
			t.messageHandler!(clientId, { type: "sync_declare", table: "posts" });
			t.messageHandler!(clientId, { type: "bootstrap" });
			await new Promise((r) => setTimeout(r, 10));
		};

		await connect(a.transport, "cA");
		await connect(b.transport, "cB");

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:x" });
		const op = {
			id: "ha-op-1",
			table: "posts",
			op: "insert" as const,
			rowId: "r1",
			payload: { title: "shared" },
			hlc,
		};

		// Same client sends same op to BOTH instances concurrently
		// (e.g. retry hits the load balancer twice).
		await Promise.all([
			(async () => {
				a.transport.messageHandler!("cA", { type: "ops", token: "valid", ops: [op] });
			})(),
			(async () => {
				b.transport.messageHandler!("cB", { type: "ops", token: "valid", ops: [op] });
			})(),
		]);
		await new Promise((r) => setTimeout(r, 30));

		// Mutate must fire AT MOST ONCE despite both instances seeing the op.
		expect(mutateCalls).toBe(1);
		expect(sharedRows.size).toBe(1);
	});
});

describe("Message queue backpressure", () => {
	test("disconnects client when queue depth exceeded", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: async () => [],
			tableDependencies: new Set(["posts"]),
			options: {
				tables: ["posts"],
				conflict: "lww",
				mutate: async () => {},
			},
		});

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));

		// Flood the queue with more than 100 messages (without awaiting)
		for (let i = 0; i < 110; i++) {
			transport.messageHandler!("client1", { type: "bootstrap" });
		}
		await new Promise((r) => setTimeout(r, 50));

		const disconnects = transport.sentMessages.filter((m) => m.message.type === "disconnect");
		expect(disconnects.length).toBeGreaterThan(0);
		expect((disconnects[0]!.message as { reason: string }).reason).toBe("Message queue overflow");
	});

	test("drains in-flight acks BEFORE disconnect on overflow", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));
		handler.setQuery("posts", {
			name: "posts",
			callback: async () => [],
			tableDependencies: new Set(["posts"]),
			options: {
				tables: ["posts"],
				conflict: "lww",
				mutate: async () => {
					// Simulate slow mutate to keep queue depth high
					await new Promise((r) => setTimeout(r, 2));
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
		await new Promise((r) => setTimeout(r, 10));
		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		transport.messageHandler!("client1", { type: "bootstrap" });
		await new Promise((r) => setTimeout(r, 10));
		transport.sentMessages.length = 0;

		// Push real ops to fill queue past threshold. First N ops go through;
		// then overflow trips. We verify acks for the ops that DID enqueue
		// arrive before the disconnect.
		for (let i = 0; i < 110; i++) {
			transport.messageHandler!("client1", {
				type: "ops",
				token: "valid",
				ops: [
					{
						id: `op-${i}`,
						table: "posts",
						op: "insert",
						rowId: `r${i}`,
						payload: { id: `r${i}` },
						hlc: `0000000000000000000.${String(i).padStart(4, "0")}.client:a`,
					},
				],
			});
		}
		// Overflow drains the whole in-flight queue before disconnecting, so how
		// long this takes scales with the mutate delay above — poll instead of
		// guessing a duration.
		await waitFor(() =>
			transport.sentMessages.some((m) => m.message.type === "disconnect"),
		);

		const acks = transport.sentMessages.filter((m) => m.message.type === "ack");
		const disconnect = transport.sentMessages.find((m) => m.message.type === "disconnect");
		expect(acks.length).toBeGreaterThan(0);
		expect(disconnect).toBeDefined();

		// Disconnect must come AFTER at least one ack (drain ordering)
		const disconnectIdx = transport.sentMessages.findIndex(
			(m) => m.message.type === "disconnect",
		);
		const lastAckIdx = transport.sentMessages
			.map((m, i) => (m.message.type === "ack" ? i : -1))
			.filter((i) => i >= 0)
			.pop()!;
		expect(disconnectIdx).toBeGreaterThan(lastAckIdx);
	}, 15000);
});

describe("unknown query rejection", () => {
	test("sync_declare for unknown query sends reject", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		// Register NO queries
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await new Promise((r) => setTimeout(r, 10));

		transport.sentMessages.length = 0;

		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "nonexistent",
		});
		await new Promise((r) => setTimeout(r, 10));

		const reject = transport.sentMessages.find((m) => m.message.type === "reject");
		expect(reject).toBeDefined();
		expect((reject!.message as RejectMessage).reason).toBe("unknown_query");
		expect((reject!.message as RejectMessage).opId).toBe("sync_declare:nonexistent");
	});
});

describe("Registration validation (type safety)", () => {
	test("setQuery throws when callback is not a function", () => {
		const transport = createMockTransport();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		expect(() =>
			handler.setQuery("bad", {
				name: "bad",
				callback: "not-a-fn" as never,
				tableDependencies: new Set(["x"]),
				options: { tables: ["x"] },
			}),
		).toThrow(/callback must be a function/);
	});

	test("setQuery throws when mutate is not a function", () => {
		const transport = createMockTransport();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		expect(() =>
			handler.setQuery("bad", {
				name: "bad",
				callback: async () => [],
				tableDependencies: new Set(["x"]),
				options: { tables: ["x"], mutate: 42 as never },
			}),
		).toThrow(/mutate must be a function/);
	});

	test("setQuery throws when authorize is not a function", () => {
		const transport = createMockTransport();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		expect(() =>
			handler.setQuery("bad", {
				name: "bad",
				callback: async () => [],
				tableDependencies: new Set(["x"]),
				options: { tables: ["x"], authorize: "string" as never },
			}),
		).toThrow(/authorize must be a function/);
	});
});

describe("reasonFromError safety", () => {
	test("MutationError with invalid reason string falls back to server_error", async () => {
		const { reasonFromError, MutationError } = await import("../../src/core/types.ts");
		const err = new MutationError("not_a_real_reason" as never, "boom");
		expect(reasonFromError(err)).toBe("server_error");
	});

	test("plain Error falls back to server_error", async () => {
		const { reasonFromError } = await import("../../src/core/types.ts");
		expect(reasonFromError(new Error("oops"))).toBe("server_error");
	});

	test("non-Error throw falls back to server_error", async () => {
		const { reasonFromError } = await import("../../src/core/types.ts");
		expect(reasonFromError("string")).toBe("server_error");
		expect(reasonFromError(undefined)).toBe("server_error");
		expect(reasonFromError({ reason: "rate_limited" })).toBe("server_error");
	});

	test("MutationError with valid ErrorReason returns it", async () => {
		const { reasonFromError, MutationError } = await import("../../src/core/types.ts");
		expect(reasonFromError(new MutationError("rate_limited"))).toBe("rate_limited");
		expect(reasonFromError(new MutationError("merge_stale"))).toBe("merge_stale");
	});
});
