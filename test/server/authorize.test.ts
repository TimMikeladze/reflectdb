import { describe, expect, test } from "bun:test";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { createMockTransport } from "./helpers.ts";
import { packHlc } from "../../src/core/hlc.ts";
import { PROTOCOL_VERSION, MutationError } from "../../src/core/types.ts";
import type { RejectMessage } from "../../src/core/types.ts";

function createMockStorage(): StorageAdapter {
	const store = new Map<
		string,
		{ row: Record<string, unknown>; colClocks: Record<string, string>; hlc: string }
	>();
	return {
		async getRow(table: string, rowId: string) {
			const key = `${table}:${rowId}`;
			const entry = store.get(key);
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

describe("authorize — read access", () => {
	test("authorize rejects sync_declare when read auth fails", async () => {
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
				authorize: async (action) => {
					if (action.type === "read") {
						throw new MutationError("auth_revoked", "Not allowed to read");
					}
				},
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
		await tick();

		transport.sentMessages.length = 0;

		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		await tick();

		const reject = transport.sentMessages.find((m) => m.message.type === "reject");
		expect(reject).toBeDefined();
		expect((reject!.message as RejectMessage).reason).toBe("auth_revoked");
		// Reject includes opId with query name for debuggability
		expect((reject!.message as RejectMessage).opId).toBe("sync_declare:posts");

		// Subscription should NOT be registered
		const session = handler.getSessions().get("client1");
		expect(session!.subscriptions.has("posts")).toBe(false);
	});

	test("authorize allows sync_declare when read auth passes", async () => {
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
				authorize: async () => {
					// No throw = allow
				},
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
		await tick();

		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
		});
		await tick();

		const session = handler.getSessions().get("client1");
		expect(session!.subscriptions.has("posts")).toBe(true);
	});

	test("authorize receives correct discriminated action for reads", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
		const handler = new MessageHandler({ transport, serverId: "test", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		let receivedAction: unknown;
		let receivedCtx: unknown;

		handler.setQuery("posts", {
			name: "posts",
			callback: async () => [],
			tableDependencies: new Set(["posts"]),
			options: {
				tables: ["posts"],
				authorize: async (action, ctx) => {
					receivedAction = action;
					receivedCtx = ctx;
				},
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
		await tick();

		transport.messageHandler!("client1", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "org-1" },
		});
		await tick();

		expect(receivedAction).toEqual({ type: "read", table: "posts", params: { orgId: "org-1" } });
		expect((receivedCtx as { auth: { userId: string } }).auth.userId).toBe("user1");
	});
});

describe("authorize — write access", () => {
	test("authorize rejects write when write auth fails", async () => {
		const transport = createMockTransport();
		const storage = createMockStorage();
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
				authorize: async (action) => {
					if (action.type === "write" && action.op.type === "delete") {
						throw new MutationError("auth_revoked", "Only admins can delete");
					}
				},
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

		transport.sentMessages.length = 0;

		// Insert should succeed
		const hlc1 = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-insert",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "hello" },
					hlc: hlc1,
				},
			],
		});
		await tick();

		const ack = transport.sentMessages.find((m) => m.message.type === "ack");
		expect(ack).toBeDefined();

		// Delete should be rejected
		const hlc2 = packHlc({ ms: Date.now(), counter: 1, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{ id: "op-delete", table: "posts", op: "delete", rowId: "r1", payload: null, hlc: hlc2 },
			],
		});
		await tick();

		const reject = transport.sentMessages.find((m) => m.message.type === "reject");
		expect(reject).toBeDefined();
		expect((reject!.message as RejectMessage).reason).toBe("auth_revoked");
	});

	test("non-MutationError in authorize becomes server_error", async () => {
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
				authorize: async () => {
					throw new Error("unexpected crash");
				},
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
});
