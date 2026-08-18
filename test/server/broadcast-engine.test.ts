import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { stableStringify } from "../../src/server/broadcast-engine.ts";
import { createMockTransport } from "./helpers.ts";
import { packHlc } from "../../src/core/hlc.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type { ServerMessage } from "../../src/core/types.ts";

async function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function connectClient(
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
): Promise<void> {
	transport.connectHandler!(clientId, new Request("https://sync"));
	transport.messageHandler!(clientId, {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId,
		token: "valid",
	});
	await tick();
}

function deltasFor(
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
): Array<Extract<ServerMessage, { type: "delta" }>> {
	return transport.sentMessages
		.filter((m) => m.clientId === clientId && m.message.type === "delta")
		.map((m) => m.message as Extract<ServerMessage, { type: "delta" }>);
}

describe("stableStringify", () => {
	test("is insensitive to key insertion order", () => {
		expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(
			stableStringify({ b: { d: 3, c: 2 }, a: 1 }),
		);
	});

	test("still distinguishes different values", () => {
		expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
	});

	test("preserves array order", () => {
		expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
	});
});

describe("broadcast grouping", () => {
	test("auth objects differing only in key order share one query execution", async () => {
		const transport = createMockTransport();
		const rows: Record<string, unknown>[] = [];
		let executions = 0;

		// Same fields, different insertion order per client. JSON.stringify would
		// hash these to different group keys and run the query twice.
		const authByClient: Record<string, Record<string, unknown>> = {
			"client-a": { userId: "u1", orgId: "acme", role: "admin" },
			"client-b": { role: "admin", orgId: "acme", userId: "u1" },
			"client-c": { userId: "u1", orgId: "acme", role: "admin" },
		};
		let nextClient = "";

		const server = createServer({
			db: {},
			transport,
		});
		server.auth(async () => authByClient[nextClient]!);
		server.query(
			"posts",
			() => {
				executions++;
				return Promise.resolve([...rows]);
			},
			{
				tables: ["posts"],
				mutate: async (op) => {
					rows.push({ id: op.rowId, ...op.payload });
				},
			},
		);

		for (const clientId of ["client-a", "client-b", "client-c"]) {
			nextClient = clientId;
			await connectClient(transport, clientId);
			transport.messageHandler!(clientId, { type: "sync_declare", table: "posts" });
			await tick();
		}

		executions = 0;
		nextClient = "client-a";
		transport.messageHandler!("client-a", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-1",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "hi" },
					hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" }),
				},
			],
		});
		await tick(30);

		expect(executions).toBe(1);
		expect(deltasFor(transport, "client-b").length).toBe(1);
		expect(deltasFor(transport, "client-c").length).toBe(1);
		await server.close();
	});

	test("groupBy collapses distinct auth contexts into one execution", async () => {
		const transport = createMockTransport();
		const rows: Record<string, unknown>[] = [];
		let executions = 0;
		let nextUser = "";

		const server = createServer({ db: {}, transport });
		server.auth(async () => ({ userId: nextUser, orgId: "acme" }));
		server.query(
			"posts",
			() => {
				executions++;
				return Promise.resolve([...rows]);
			},
			{
				tables: ["posts"],
				// Results depend only on the org, so every member of the org can
				// be served by one execution.
				groupBy: ({ auth }) => String(auth.orgId),
				mutate: async (op) => {
					rows.push({ id: op.rowId, ...op.payload });
				},
			},
		);

		for (const clientId of ["c1", "c2", "c3"]) {
			nextUser = `user-${clientId}`;
			await connectClient(transport, clientId);
			transport.messageHandler!(clientId, { type: "sync_declare", table: "posts" });
			await tick();
		}

		executions = 0;
		nextUser = "user-c1";
		transport.messageHandler!("c1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-1",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "hi" },
					hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:c1" }),
				},
			],
		});
		await tick(30);

		// Without groupBy this would be 2 (one per distinct auth context).
		expect(executions).toBe(1);
		expect(deltasFor(transport, "c2").length).toBe(1);
		expect(deltasFor(transport, "c3").length).toBe(1);
		await server.close();
	});
});

describe("result cache commit", () => {
	test("a dropped delta is re-sent on the next broadcast", async () => {
		const transport = createMockTransport();
		const rows: Record<string, unknown>[] = [];

		const server = createServer({ db: {}, transport });
		server.auth(async () => ({ userId: "u1" }));
		server.query("posts", () => Promise.resolve([...rows]), {
			tables: ["posts"],
			mutate: async (op) => {
				rows.push({ id: op.rowId, ...op.payload });
			},
		});

		await connectClient(transport, "writer");
		await connectClient(transport, "reader");
		transport.messageHandler!("reader", { type: "sync_declare", table: "posts" });
		transport.messageHandler!("writer", { type: "sync_declare", table: "posts" });
		await tick();

		// Reader's socket drops everything for the first write.
		transport.failSend = (clientId, message) => clientId === "reader" && message.type === "delta";

		transport.messageHandler!("writer", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-1",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "first" },
					hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:w" }),
				},
			],
		});
		await tick(30);
		expect(deltasFor(transport, "reader").length).toBe(0);

		// Socket recovers. The withheld cache commit means the next broadcast
		// still sees r1 as missing and re-sends it.
		transport.failSend = null;
		transport.messageHandler!("writer", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-2",
					table: "posts",
					op: "insert",
					rowId: "r2",
					payload: { title: "second" },
					hlc: packHlc({ ms: Date.now(), counter: 1, nodeId: "client:w" }),
				},
			],
		});
		await tick(30);

		const rowIds = deltasFor(transport, "reader").map((d) => d.rowId);
		expect(rowIds).toContain("r1");
		expect(rowIds).toContain("r2");
		await server.close();
	});

	test("concurrent broadcasts do not strand a row on the client", async () => {
		const transport = createMockTransport();

		// Two broadcasts race for the same (client, query):
		//   A sees [r1], B sees [r2] — r1 is gone by the time B runs.
		// A's diff resolves first but its send is slow, so without
		// serialization B diffs against the same empty cache, sees no r1 to
		// delete, and commits {r2} last. The cache then permanently disagrees
		// with the client, which was sent an insert for r1 and no delete.
		const snapshots: Record<string, unknown>[][] = [[{ id: "r1" }], [{ id: "r2" }]];
		const queryDelays = [0, 2];
		let call = 0;

		const server = createServer({ db: {}, transport });
		server.auth(async () => ({ userId: "u1" }));
		server.query(
			"posts",
			async () => {
				const n = call++;
				await tick(queryDelays[n] ?? 0);
				return snapshots[n] ?? [{ id: "r2" }];
			},
			{ tables: ["posts"] },
		);

		await connectClient(transport, "reader");
		transport.messageHandler!("reader", { type: "sync_declare", table: "posts" });
		await tick();
		transport.sentMessages.length = 0;
		call = 0;

		transport.sendDelay = (_clientId, message) =>
			message.type === "delta" && message.rowId === "r1" ? 5 : 25;

		const a = server.notifyChange("posts");
		const b = server.notifyChange("posts");
		await Promise.all([a, b]);

		// A third broadcast confirming r1 really is gone. If the cache lost
		// track of r1, no delete is ever emitted for it again.
		transport.sendDelay = null;
		await server.notifyChange("posts");
		await tick(20);

		const deltas = deltasFor(transport, "reader");
		expect(deltas.some((d) => d.op === "insert" && d.rowId === "r1")).toBe(true);
		expect(deltas.some((d) => d.op === "delete" && d.rowId === "r1")).toBe(true);
		await server.close();
	});
});

describe("a writer's own cached result", () => {
	test("re-creating a rowId the writer deleted resends the whole row", async () => {
		const transport = createMockTransport();
		// A server-materialized row: the client only ever writes `seq`, the
		// server owns `board` and `name`. Deleting and re-creating the same id
		// is the shape that broke — an empty board on both sides of the delete
		// meant the diff had nothing to report for `board`.
		const rows = new Map<string, Record<string, unknown>>();
		let nextName = 1;

		const server = createServer({ db: {}, transport });
		server.auth(async () => ({ userId: "u1" }));
		server.query("boards", () => Promise.resolve([...rows.values()]), {
			tables: ["boards"],
			mutate: async (op) => {
				if (op.type === "delete") {
					rows.delete(op.rowId);
					return;
				}
				const existing = rows.get(op.rowId);
				rows.set(op.rowId, {
					id: op.rowId,
					name: existing?.name ?? `board-${nextName++}`,
					board: existing?.board ?? "empty",
					seq: (op.payload as { seq: number }).seq,
				});
			},
		});

		await connectClient(transport, "writer");
		transport.messageHandler!("writer", { type: "sync_declare", table: "boards" });
		await tick();

		const send = async (op: "insert" | "delete", seq: number) => {
			transport.messageHandler!("writer", {
				type: "ops",
				token: "valid",
				ops: [
					{
						id: `op-${op}-${seq}`,
						table: "boards",
						op,
						rowId: "w1",
						payload: op === "delete" ? null : { seq },
						hlc: packHlc({ ms: Date.now() + seq, counter: 0, nodeId: "client:writer" }),
					},
				],
			});
			await tick();
		};

		// The writer is excluded from the broadcast of its own op, so — like the
		// Tetris example — the server re-queries once afterwards so the writer
		// receives the server's version of the row it just wrote. That pass is
		// coalesced, which is what makes the delete invisible: a leave and the
		// re-join that follows it settle into a single re-query.
		const reconcile = async () => {
			await server.notifyChange("boards");
			await tick();
		};

		await send("insert", 1);
		await reconcile();
		transport.sentMessages.length = 0;

		await send("delete", 2);
		await send("insert", 3);
		await reconcile();

		const deltas = deltasFor(transport, "writer").filter((d) => d.rowId === "w1");
		expect(deltas.length).toBe(1);
		expect(deltas[0]!.op).toBe("insert");
		// `board` is identical to the deleted row's, so a diff against that dead
		// row would have dropped it and left the client with a partial row.
		expect(deltas[0]!.payload).toEqual({ id: "w1", name: "board-2", board: "empty", seq: 3 });
		await server.close();
	});
});

describe("query timeout", () => {
	test("a hung query does not stall fanout to other groups", async () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
			queryTimeoutMs: 25,
		});

		let nextUser = "";
		server.auth(async () => ({ userId: nextUser }));
		server.query(
			"posts",
			async (ctx) => {
				// One tenant's query never resolves.
				if (ctx.auth.userId === "slow") await tick(5_000);
				return [{ id: "r1" }];
			},
			{ tables: ["posts"] },
		);

		for (const [clientId, user] of [
			["slow-client", "slow"],
			["fast-client", "fast"],
		]) {
			nextUser = user!;
			await connectClient(transport, clientId!);
			transport.messageHandler!(clientId!, { type: "sync_declare", table: "posts" });
			await tick();
		}
		transport.sentMessages.length = 0;

		const started = Date.now();
		await server.notifyChange("posts");
		const elapsed = Date.now() - started;

		expect(deltasFor(transport, "fast-client").length).toBe(1);
		expect(deltasFor(transport, "slow-client").length).toBe(0);
		// Bounded by the timeout, not by the hung query.
		expect(elapsed).toBeLessThan(1_000);
		await server.close();
	});
});
