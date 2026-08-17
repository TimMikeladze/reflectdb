import { describe, expect, test } from "bun:test";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { createMockTransport } from "./helpers.ts";
import { packHlc } from "../../src/core/hlc.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";

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

describe("Query-based broadcast filtering", () => {
	test("delta is only sent when query results change (filtered by query callback)", async () => {
		const transport = createMockTransport();
		const storage = createInMemoryStorage();
		const handler = new MessageHandler({ transport, serverId: "test", db: { storage } });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "user1" }));

		// Query callback filters: only return rows with orgId === "org-a"
		handler.setQuery("posts", {
			name: "posts",
			callback: async (_ctx: any, db: any) => {
				const { rows } = await db.storage.getRows("posts");
				return rows.filter((r: any) => r.orgId === "org-a");
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

		// Connect client A (subscribed)
		transport.connectHandler!("clientA", new Request("https://sync"));
		transport.messageHandler!("clientA", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "clientA",
			token: "valid",
		});
		await tick();
		transport.messageHandler!("clientA", { type: "sync_declare", table: "posts" });
		await tick();

		// Connect client B (subscribed)
		transport.connectHandler!("clientB", new Request("https://sync"));
		transport.messageHandler!("clientB", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "clientB",
			token: "valid",
		});
		await tick();
		transport.messageHandler!("clientB", { type: "sync_declare", table: "posts" });
		await tick();

		// Connect client C (the sender)
		transport.connectHandler!("clientC", new Request("https://sync"));
		transport.messageHandler!("clientC", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "clientC",
			token: "valid",
		});
		await tick();
		transport.messageHandler!("clientC", { type: "sync_declare", table: "posts" });
		await tick();

		transport.sentMessages.length = 0;

		// Client C inserts a row that matches the query filter (orgId === "org-a")
		const hlc1 = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:c" });
		transport.messageHandler!("clientC", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-match",
					table: "posts",
					op: "insert",
					rowId: "r-match",
					payload: { title: "hello", orgId: "org-a" },
					hlc: hlc1,
				},
			],
		});
		await tick();

		// Both A and B should receive delta (query returns the new row)
		const deltasA = transport.sentMessages.filter(
			(m) => m.clientId === "clientA" && m.message.type === "delta",
		);
		const deltasB = transport.sentMessages.filter(
			(m) => m.clientId === "clientB" && m.message.type === "delta",
		);
		expect(deltasA.length).toBe(1);
		expect(deltasB.length).toBe(1);

		transport.sentMessages.length = 0;

		// Client C inserts a row that does NOT match the query filter (orgId === "org-b")
		const hlc2 = packHlc({ ms: Date.now() + 1, counter: 0, nodeId: "client:c" });
		transport.messageHandler!("clientC", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-nomatch",
					table: "posts",
					op: "insert",
					rowId: "r-nomatch",
					payload: { title: "hidden", orgId: "org-b" },
					hlc: hlc2,
				},
			],
		});
		await tick();

		// Neither A nor B should receive delta (query still returns same results, org-b row is filtered out)
		const deltasA2 = transport.sentMessages.filter(
			(m) => m.clientId === "clientA" && m.message.type === "delta",
		);
		const deltasB2 = transport.sentMessages.filter(
			(m) => m.clientId === "clientB" && m.message.type === "delta",
		);
		expect(deltasA2.length).toBe(0);
		expect(deltasB2.length).toBe(0);

		// Client C still gets ack for both
		const acks = transport.sentMessages.filter(
			(m) => m.clientId === "clientC" && m.message.type === "ack",
		);
		expect(acks.length).toBe(1);
	});
});
