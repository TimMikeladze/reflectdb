import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { parseDuration } from "../../src/server/server.ts";
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
			else store.set(`${table}:${rowId}`, { row, colClocks, hlc });
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

describe("createServer integration with MessageHandler", () => {
	test("createServer wires auth/shape to handler and processes ops", async () => {
		const transport = createMockTransport();
		const storage = createInMemoryStorage();

		const server = createServer({
			db: {},
			transport,
			serverId: "integration-test",
			storage,
		});

		// Register auth and shape via server API
		server.auth(async (req) => {
			const token = req.headers.get("authorization")?.replace("Bearer ", "");
			if (token === "valid") return { userId: "user1" };
			throw new Error("Invalid");
		});

		server.query("posts", async () => (await storage.getRows("posts")).rows, {
			tables: ["posts"],
			conflict: "lww",
			serverSet: { orgId: "org-server" },
			mutate: async (op) => {
				if (op.type === "delete") {
					await storage.putRow("posts", op.rowId, null, {}, op.hlc);
				} else {
					await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
				}
			},
		});

		// Simulate client connection
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();

		const ack = transport.sentMessages.find((m) => m.message.type === "hello_ack");
		expect(ack).toBeDefined();
		expect((ack!.message as { serverId: string }).serverId).toBe("integration-test");

		// Subscribe and send op
		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		await tick();

		transport.sentMessages.length = 0;

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-int-1",
					table: "posts",
					op: "insert",
					rowId: "row-int",
					payload: { title: "test" },
					hlc,
				},
			],
		});
		await tick();

		// Should get ack
		const opAck = transport.sentMessages.find((m) => m.message.type === "ack");
		expect(opAck).toBeDefined();

		// Stored row should have serverSet orgId
		const row = await storage.getRow("posts", "row-int");
		expect(row.row).toBeDefined();
		expect(row.row!.orgId).toBe("org-server");
	});

	test("rateLimit via createServer creates limiter in handler", async () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
			storage: createInMemoryStorage(),
		});

		server.auth(async () => ({ userId: "user1" }));
		server.query("posts", async () => (await createInMemoryStorage().getRows("posts")).rows, {
			tables: ["posts"],
			conflict: "lww",
			mutate: async () => {},
		});
		server.rateLimit({ opsPerSecond: 1 });

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

		// Send 2 ops — second should be rate limited
		const hlc1 = packHlc({ ms: Date.now(), counter: 0, nodeId: "c:1" });
		const hlc2 = packHlc({ ms: Date.now(), counter: 1, nodeId: "c:1" });

		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "rl-1",
					table: "posts",
					op: "insert",
					rowId: "rl1",
					payload: { title: "a" },
					hlc: hlc1,
				},
				{
					id: "rl-2",
					table: "posts",
					op: "insert",
					rowId: "rl2",
					payload: { title: "b" },
					hlc: hlc2,
				},
			],
		});
		await tick();

		const reject = transport.sentMessages.find((m) => m.message.type === "reject");
		expect(reject).toBeDefined();
		expect((reject!.message as { reason: string }).reason).toBe("rate_limited");
	});
});

describe("parseDuration", () => {
	test("parses milliseconds", () => {
		expect(parseDuration("500ms")).toBe(500);
	});

	test("parses seconds", () => {
		expect(parseDuration("30s")).toBe(30000);
	});

	test("parses minutes", () => {
		expect(parseDuration("5m")).toBe(300000);
	});

	test("parses hours", () => {
		expect(parseDuration("2h")).toBe(7200000);
	});

	test("parses days", () => {
		expect(parseDuration("7d")).toBe(604800000);
	});

	test("throws for invalid input", () => {
		expect(() => parseDuration("invalid")).toThrow('Invalid duration: "invalid"');
	});
});
