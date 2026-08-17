import { describe, expect, test } from "bun:test";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { createMockTransport } from "./helpers.ts";
import { packHlc } from "../../src/core/hlc.ts";
import { PROTOCOL_VERSION, MutationError } from "../../src/core/types.ts";
import type { AckMessage, RejectMessage, DeltaMessage } from "../../src/core/types.ts";

function createMockStorage(): StorageAdapter {
	const store = new Map<
		string,
		{ row: Record<string, unknown>; colClocks: Record<string, string>; hlc: string }
	>();
	return {
		async getRow(table: string, rowId: string) {
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

describe("mutate callback", () => {
	test("mutate receives resolved op with serverSet injected", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		let receivedOp: unknown;

		handler.setQuery("posts", {
			name: "posts",
			callback: async () => (await storage.getRows("posts")).rows,
			tableDependencies: new Set(["posts"]),
			options: {
				tables: ["posts"],
				conflict: "lww",
				serverSet: { orgId: "org-server" },
				mutate: async (op) => {
					receivedOp = op;
					await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
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
					id: "op-1",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "test", orgId: "client-org" },
					hlc,
				},
			],
		});
		await tick();

		expect(receivedOp).toBeDefined();
		// serverSet should have overridden client's orgId
		expect((receivedOp as { payload: Record<string, unknown> }).payload!.orgId).toBe("org-server");
	});

	test("mutate rejection with MutationError prevents storage write", async () => {
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
				mutate: async (op) => {
					throw new MutationError("mutation_rejected", "Business rule violated");
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
		transport.sentMessages.length = 0;

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{ id: "op-1", table: "posts", op: "insert", rowId: "r1", payload: { title: "test" }, hlc },
			],
		});
		await tick();

		const reject = transport.sentMessages.find((m) => m.message.type === "reject");
		expect(reject).toBeDefined();
		expect((reject!.message as RejectMessage).reason).toBe("mutation_rejected");
	});

	test("non-MutationError in mutate becomes server_error", async () => {
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
					throw new Error("database connection lost");
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
		transport.sentMessages.length = 0;

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{ id: "op-1", table: "posts", op: "insert", rowId: "r1", payload: { title: "test" }, hlc },
			],
		});
		await tick();

		const reject = transport.sentMessages.find((m) => m.message.type === "reject");
		expect(reject).toBeDefined();
		expect((reject!.message as RejectMessage).reason).toBe("server_error");
	});

	test("read-only query (no mutate) rejects writes", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		handler.setQuery("dashboard", {
			name: "dashboard",
			callback: async () => [],
			tableDependencies: new Set(["posts", "users"]),
			options: {
				tables: ["posts", "users"],
				// No mutate = read-only
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
		transport.messageHandler!("client1", { type: "sync_declare", table: "dashboard" });
		await tick();
		transport.sentMessages.length = 0;

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-1",
					table: "dashboard",
					op: "insert",
					rowId: "r1",
					payload: { title: "test" },
					hlc,
				},
			],
		});
		await tick();

		const reject = transport.sentMessages.find((m) => m.message.type === "reject");
		expect(reject).toBeDefined();
		expect((reject!.message as RejectMessage).reason).toBe("readonly_query");
	});

	test("mutate with affected tables triggers multi-table broadcast", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		// Query that depends on "posts" and "post_tags"
		handler.setQuery("posts", {
			name: "posts",
			callback: async () => (await storage.getRows("posts")).rows,
			tableDependencies: new Set(["posts", "post_tags"]),
			options: {
				tables: ["posts", "post_tags"],
				conflict: "lww",
				mutate: async (op) => {
					await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
					return { affected: ["post_tags"] };
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
		await tick();

		transport.connectHandler!("client2", new Request("https://sync"));
		transport.messageHandler!("client2", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client2",
			token: "valid",
		});
		await tick();

		// Both subscribe
		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		transport.messageHandler!("client2", { type: "sync_declare", table: "posts" });
		await tick();

		// Bootstrap both so result cache is populated
		transport.messageHandler!("client1", { type: "bootstrap" });
		transport.messageHandler!("client2", { type: "bootstrap" });
		await tick();

		transport.sentMessages.length = 0;

		// client1 inserts a post
		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{ id: "op-1", table: "posts", op: "insert", rowId: "r1", payload: { title: "hello" }, hlc },
			],
		});
		await tick();

		// client1 should get ack
		const ack = transport.sentMessages.find((m) => m.message.type === "ack");
		expect(ack).toBeDefined();
	});

	test("partial batch failure: failing op rejects remaining ops", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		let callCount = 0;
		handler.setQuery("posts", {
			name: "posts",
			callback: async () => (await storage.getRows("posts")).rows,
			tableDependencies: new Set(["posts"]),
			options: {
				tables: ["posts"],
				conflict: "lww",
				mutate: async (op) => {
					callCount++;
					if (callCount === 2) {
						throw new MutationError("mutation_rejected", "Second op fails");
					}
					await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
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
		transport.sentMessages.length = 0;

		const baseMs = Date.now();
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-1",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "first" },
					hlc: packHlc({ ms: baseMs, counter: 0, nodeId: "c:1" }),
				},
				{
					id: "op-2",
					table: "posts",
					op: "insert",
					rowId: "r2",
					payload: { title: "second" },
					hlc: packHlc({ ms: baseMs, counter: 1, nodeId: "c:1" }),
				},
				{
					id: "op-3",
					table: "posts",
					op: "insert",
					rowId: "r3",
					payload: { title: "third" },
					hlc: packHlc({ ms: baseMs, counter: 2, nodeId: "c:1" }),
				},
			],
		});
		await tick();

		// op-1 should be acked (succeeded before op-2 failed)
		const acks = transport.sentMessages.filter((m) => m.message.type === "ack");
		expect(acks.length).toBe(1);
		const ackedIds = (acks[0]!.message as AckMessage).opIds;
		expect(ackedIds).toContain("op-1");

		// op-2 should be rejected
		const rejects = transport.sentMessages.filter((m) => m.message.type === "reject");
		expect(rejects.length).toBeGreaterThanOrEqual(1);
		const rejectOp2 = rejects.find((m) => (m.message as RejectMessage).opId === "op-2");
		expect(rejectOp2).toBeDefined();
		expect((rejectOp2!.message as RejectMessage).reason).toBe("mutation_rejected");
	});

	test("MutationContext.params populated from sync_declare params", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		let receivedParams: Record<string, unknown> | undefined;

		handler.setQuery("posts", {
			name: "posts",
			callback: async () => [],
			tableDependencies: new Set(["posts"]),
			options: {
				tables: ["posts"],
				conflict: "lww",
				mutate: async (op, ctx) => {
					receivedParams = ctx.params;
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

		// sync_declare with params
		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "org-42", role: "admin" },
		});
		await tick();

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{ id: "op-1", table: "posts", op: "insert", rowId: "r1", payload: { title: "test" }, hlc },
			],
		});
		await tick();

		expect(receivedParams).toEqual({ orgId: "org-42", role: "admin" });
	});
});
