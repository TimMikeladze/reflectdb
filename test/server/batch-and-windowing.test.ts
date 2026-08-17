import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
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

interface Counts {
	getRow: number;
	getRowsByIds: number;
	reserveOp: number;
	reserveOps: number;
	getOpsSince: number;
	getChangedTablesSince: number;
	getOplogHead: number;
}

function createCountingStorage(opts: { batch: boolean }): {
	adapter: StorageAdapter;
	counts: Counts;
	appendedTables: string[];
} {
	const rows = new Map<string, { row: Record<string, unknown>; colClocks: Record<string, string>; hlc: string }>();
	const ops: Array<{ table: string; hlc: string }> = [];
	const reserved = new Set<string>();
	const meta = new Map<string, string>();
	const counts: Counts = {
		getRow: 0,
		getRowsByIds: 0,
		reserveOp: 0,
		reserveOps: 0,
		getOpsSince: 0,
		getChangedTablesSince: 0,
		getOplogHead: 0,
	};

	const base: StorageAdapter = {
		async getRow(table, rowId) {
			counts.getRow++;
			const e = rows.get(`${table}:${rowId}`);
			return e ? { row: e.row, rowHlc: e.hlc, colClocks: e.colClocks } : { row: null, rowHlc: null, colClocks: {} };
		},
		async putRow(table, rowId, row, colClocks, hlc) {
			if (row === null) rows.delete(`${table}:${rowId}`);
			else rows.set(`${table}:${rowId}`, { row, colClocks, hlc });
		},
		async getRows() {
			return { rows: [], colClocks: {} };
		},
		async appendOp(entry) {
			ops.push({ table: entry.table, hlc: entry.hlc });
		},
		async applyOp(table, rowId, row, colClocks, hlc) {
			if (row === null) rows.delete(`${table}:${rowId}`);
			else rows.set(`${table}:${rowId}`, { row, colClocks, hlc });
			ops.push({ table, hlc });
		},
		async getOpsSince(since, tables) {
			counts.getOpsSince++;
			return ops
				.filter((o) => o.hlc > since && tables.includes(o.table))
				.map((o) => ({
					table: o.table,
					op: "insert",
					rowId: "x",
					payload: null,
					hlc: o.hlc,
					colClocks: {},
				}));
		},
		async deleteOpsBefore() {
			return 0;
		},
		async reserveOp(opId) {
			counts.reserveOp++;
			if (reserved.has(opId)) return false;
			reserved.add(opId);
			return true;
		},
		async getMeta(key) {
			return meta.get(key) ?? null;
		},
		async setMeta(key, value) {
			meta.set(key, value);
		},
	};

	if (opts.batch) {
		base.getRowsByIds = async (table, rowIds) => {
			counts.getRowsByIds++;
			const out: Record<string, Awaited<ReturnType<StorageAdapter["getRow"]>>> = {};
			for (const rowId of rowIds) {
				const e = rows.get(`${table}:${rowId}`);
				if (e) out[rowId] = { row: e.row, rowHlc: e.hlc, colClocks: e.colClocks };
			}
			return out;
		};
		base.reserveOps = async (opIds) => {
			counts.reserveOps++;
			const fresh: string[] = [];
			for (const id of opIds) {
				if (!reserved.has(id)) {
					reserved.add(id);
					fresh.push(id);
				}
			}
			return fresh;
		};
		base.getChangedTablesSince = async (since, tables) => {
			counts.getChangedTablesSince++;
			return [...new Set(ops.filter((o) => o.hlc > since && tables.includes(o.table)).map((o) => o.table))];
		};
		base.getOplogHead = async (tables) => {
			counts.getOplogHead++;
			let head: string | null = null;
			for (const o of ops) {
				if (!tables.includes(o.table)) continue;
				if (head === null || o.hlc > head) head = o.hlc;
			}
			return head;
		};
	}

	return { adapter: base, counts, appendedTables: ops.map((o) => o.table) };
}

function buildOps(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: `op-${i}`,
		table: "posts",
		op: "insert" as const,
		rowId: `r${i}`,
		payload: { title: `t${i}` },
		hlc: packHlc({ ms: Date.now(), counter: i, nodeId: "client:c1" }),
	}));
}

describe("batched op processing", () => {
	test("a 50-op batch costs one reserve and one row read", async () => {
		const transport = createMockTransport();
		const { adapter, counts } = createCountingStorage({ batch: true });
		const server = createServer({ db: {}, transport, storage: adapter });
		server.auth(async () => ({ userId: "u1" }));
		server.query("posts", () => Promise.resolve([]), {
			tables: ["posts"],
			mutate: async () => {},
		});

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
		await tick();

		transport.messageHandler!("c1", { type: "ops", token: "valid", ops: buildOps(50) });
		await tick(50);

		expect(counts.reserveOps).toBe(1);
		expect(counts.reserveOp).toBe(0);
		expect(counts.getRowsByIds).toBe(1);
		expect(counts.getRow).toBe(0);
		await server.close();
	});

	test("falls back to per-op calls on adapters without batch methods", async () => {
		const transport = createMockTransport();
		const { adapter, counts } = createCountingStorage({ batch: false });
		const server = createServer({ db: {}, transport, storage: adapter });
		server.auth(async () => ({ userId: "u1" }));
		server.query("posts", () => Promise.resolve([]), {
			tables: ["posts"],
			mutate: async () => {},
		});

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
		await tick();

		transport.messageHandler!("c1", { type: "ops", token: "valid", ops: buildOps(5) });
		await tick(30);

		expect(counts.reserveOp).toBe(5);
		expect(counts.getRow).toBe(5);
		await server.close();
	});

	test("does not burn the op id of an op it rejects before the replay check", async () => {
		const transport = createMockTransport();
		const { adapter } = createCountingStorage({ batch: true });
		const applied: string[] = [];
		const server = createServer({ db: {}, transport, storage: adapter });
		server.auth(async () => ({ userId: "u1" }));
		server.query("posts", () => Promise.resolve([]), {
			tables: ["posts"],
			mutate: async (op) => {
				applied.push(op.rowId);
			},
		});

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
		await tick();

		const op = {
			id: "op-x",
			table: "unregistered",
			op: "insert" as const,
			rowId: "r1",
			payload: { title: "x" },
			hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:c1" }),
		};
		transport.messageHandler!("c1", { type: "ops", token: "valid", ops: [op] });
		await tick(20);

		const reject = transport.sentMessages.find(
			(m) => m.message.type === "reject",
		)!.message as Extract<ServerMessage, { type: "reject" }>;
		expect(reject.reason).toBe("outside_shape");

		// Retrying the same op id against the correct query must apply, not be
		// swallowed as a replay.
		transport.messageHandler!("c1", {
			type: "ops",
			token: "valid",
			ops: [{ ...op, table: "posts" }],
		});
		await tick(20);

		expect(applied).toEqual(["r1"]);
		await server.close();
	});

	test("applies a repeated op id once within a single batch", async () => {
		const transport = createMockTransport();
		const { adapter } = createCountingStorage({ batch: true });
		const applied: Array<Record<string, unknown> | null> = [];
		const server = createServer({ db: {}, transport, storage: adapter });
		server.auth(async () => ({ userId: "u1" }));
		server.query("counters", () => Promise.resolve([]), {
			tables: ["counters"],
			mutate: async (op) => {
				applied.push(op.payload);
			},
		});

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", { type: "sync_declare", table: "counters" });
		await tick();

		const op = {
			id: "op-dup",
			table: "counters",
			op: "insert" as const,
			rowId: "r1",
			payload: { n: 1 },
			hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:c1" }),
		};
		// Batch reservation returns one fresh id for two identical ops; without
		// consume-once semantics both would pass the replay gate.
		transport.messageHandler!("c1", { type: "ops", token: "valid", ops: [op, { ...op }] });
		await tick(20);

		expect(applied.length).toBe(1);
		await server.close();
	});

	test("a later op in the batch sees what an earlier op wrote", async () => {
		const transport = createMockTransport();
		const { adapter } = createCountingStorage({ batch: true });
		const applied: Array<Record<string, unknown> | null> = [];
		const server = createServer({ db: {}, transport, storage: adapter });
		server.auth(async () => ({ userId: "u1" }));
		server.query("posts", () => Promise.resolve([]), {
			tables: ["posts"],
			conflict: "merge",
			mutate: async (op) => {
				applied.push(op.payload);
			},
		});

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
		await tick();

		const now = Date.now();
		transport.messageHandler!("c1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-a",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "first", body: "b" },
					hlc: packHlc({ ms: now, counter: 0, nodeId: "client:c1" }),
				},
				{
					id: "op-b",
					table: "posts",
					op: "update",
					rowId: "r1",
					payload: { title: "second" },
					hlc: packHlc({ ms: now, counter: 1, nodeId: "client:c1" }),
				},
			],
		});
		await tick(30);

		// The prefetch cache must be write-through: op-b merges over op-a's row,
		// not over the pre-batch (empty) snapshot.
		expect(applied.length).toBe(2);
		expect(applied[1]).toMatchObject({ title: "second", body: "b" });
		await server.close();
	});
});

describe("resume", () => {
	test("uses the distinct-tables query instead of loading every op", async () => {
		const transport = createMockTransport();
		const { adapter, counts } = createCountingStorage({ batch: true });
		const server = createServer({ db: {}, transport, storage: adapter });
		server.auth(async () => ({ userId: "u1" }));
		server.query("posts", () => Promise.resolve([]), {
			tables: ["posts"],
			mutate: async () => {},
		});

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
		transport.messageHandler!("c1", { type: "bootstrap" });
		await tick(20);

		transport.messageHandler!("c1", {
			type: "resume",
			since: packHlc({ ms: 1, counter: 0, nodeId: "server:x" }),
		});
		await tick(20);

		expect(counts.getChangedTablesSince).toBe(1);
		expect(counts.getOpsSince).toBe(0);
		expect(
			transport.sentMessages.some((m) => m.message.type === "resume_complete"),
		).toBe(true);
		await server.close();
	});
});

describe("HA poll", () => {
	test("an idle tick runs no queries", async () => {
		const transport = createMockTransport();
		const { adapter, counts } = createCountingStorage({ batch: true });
		let executions = 0;

		const handler = new MessageHandler({ transport, serverId: "s1", db: {} });
		handler.setAuth(async () => ({ userId: "u1" }));
		handler.setStorage(adapter);
		handler.setQuery("posts", {
			name: "posts",
			callback: () => {
				executions++;
				return Promise.resolve([]);
			},
			tableDependencies: new Set(["posts"]),
			options: { tables: ["posts"], mutate: async () => {} },
		});

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
		await tick();
		executions = 0;

		await handler.pollRemoteChanges();
		await handler.pollRemoteChanges();
		await handler.pollRemoteChanges();

		// Head probe only — no per-subscriber query executions on idle ticks.
		expect(executions).toBe(0);
		expect(counts.getOplogHead).toBe(3);
		await handler.close();
	});

	test("broadcasts only the tables that actually changed", async () => {
		const transport = createMockTransport();
		const { adapter } = createCountingStorage({ batch: true });
		let postExecutions = 0;
		let commentExecutions = 0;

		const handler = new MessageHandler({ transport, serverId: "s1", db: {} });
		handler.setAuth(async () => ({ userId: "u1" }));
		handler.setStorage(adapter);
		handler.setQuery("posts", {
			name: "posts",
			callback: () => {
				postExecutions++;
				return Promise.resolve([]);
			},
			tableDependencies: new Set(["posts"]),
			options: { tables: ["posts"], mutate: async () => {} },
		});
		handler.setQuery("comments", {
			name: "comments",
			callback: () => {
				commentExecutions++;
				return Promise.resolve([]);
			},
			tableDependencies: new Set(["comments"]),
			options: { tables: ["comments"], mutate: async () => {} },
		});

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
		transport.messageHandler!("c1", { type: "sync_declare", table: "comments" });
		await tick();

		// Adopt the current head, then simulate a peer instance writing.
		await handler.pollRemoteChanges();
		postExecutions = 0;
		commentExecutions = 0;
		await adapter.appendOp({
			table: "posts",
			op: "insert",
			rowId: "r9",
			payload: null,
			hlc: packHlc({ ms: Date.now() + 5_000, counter: 0, nodeId: "server:peer" }),
			colClocks: {},
		});

		await handler.pollRemoteChanges();

		expect(postExecutions).toBe(1);
		expect(commentExecutions).toBe(0);
		await handler.close();
	});
});

describe("windowed queries", () => {
	test("push the window into the query and count separately", async () => {
		const transport = createMockTransport();
		const all = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, n: i }));
		const fetchedLimits: Array<number | undefined> = [];
		let countCalls = 0;

		const server = createServer({ db: {}, transport });
		server.auth(async () => ({ userId: "u1" }));
		server.query(
			"messages",
			(ctx) => {
				fetchedLimits.push(ctx.limit);
				return Promise.resolve(ctx.limit != null ? all.slice(0, ctx.limit) : all);
			},
			{
				tables: ["messages"],
				countHints: true,
				count: () => {
					countCalls++;
					return all.length;
				},
			},
		);

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", {
			type: "sync_declare",
			table: "messages",
			window: 50,
		});
		transport.messageHandler!("c1", { type: "bootstrap" });
		await tick(30);

		const snapshot = transport.sentMessages.find(
			(m) => m.message.type === "snapshot",
		)!.message as Extract<ServerMessage, { type: "snapshot" }>;

		expect(snapshot.rows.length).toBe(50);
		expect(snapshot.totalCount).toBe(1000);
		// The window is a real limit — not 1000 rows fetched and sliced in JS.
		expect(fetchedLimits).toEqual([50]);
		expect(countCalls).toBe(1);

		// Broadcasts keep the cap too.
		fetchedLimits.length = 0;
		await server.notifyChange("messages");
		expect(fetchedLimits.every((l) => l === 50)).toBe(true);
		await server.close();
	});

	test("without a count callback the full result set is still materialized", async () => {
		const transport = createMockTransport();
		const all = Array.from({ length: 120 }, (_, i) => ({ id: `r${i}` }));
		const fetchedLimits: Array<number | undefined> = [];

		const server = createServer({ db: {}, transport });
		server.auth(async () => ({ userId: "u1" }));
		server.query(
			"messages",
			(ctx) => {
				fetchedLimits.push(ctx.limit);
				return Promise.resolve(all);
			},
			{ tables: ["messages"], countHints: true },
		);

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", {
			type: "sync_declare",
			table: "messages",
			window: 10,
		});
		transport.messageHandler!("c1", { type: "bootstrap" });
		await tick(30);

		const snapshot = transport.sentMessages.find(
			(m) => m.message.type === "snapshot",
		)!.message as Extract<ServerMessage, { type: "snapshot" }>;
		expect(snapshot.rows.length).toBe(10);
		expect(snapshot.totalCount).toBe(120);
		expect(fetchedLimits).toEqual([undefined]);
		await server.close();
	});
});

describe("window entitlement", () => {
	/** A windowed subscriber over a query whose row set the test controls. */
	async function setupWindowed(window: number, initial: Record<string, unknown>[]) {
		const transport = createMockTransport();
		const state = { rows: initial };
		const server = createServer({ db: {}, transport });
		server.auth(async () => ({ userId: "u1" }));
		server.query(
			"messages",
			(ctx) => Promise.resolve(ctx.limit != null ? state.rows.slice(0, ctx.limit) : state.rows),
			{ tables: ["messages"] },
		);

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", { type: "sync_declare", table: "messages", window });
		transport.messageHandler!("c1", { type: "bootstrap" });
		await tick(20);
		transport.sentMessages.length = 0;
		return { transport, server, state };
	}

	function deltaRowIds(transport: ReturnType<typeof createMockTransport>): string[] {
		return transport.sentMessages
			.filter((m) => m.message.type === "delta")
			.map((m) => (m.message as Extract<ServerMessage, { type: "delta" }>).rowId);
	}

	test("a subscriber that bootstrapped empty still receives later inserts", async () => {
		const { transport, server, state } = await setupWindowed(50, []);

		// Slicing broadcasts to how many rows the client HOLDS (zero) instead of
		// what its window entitles it to would strand this client forever.
		state.rows = [{ id: "r1" }, { id: "r2" }];
		await server.notifyChange("messages");
		await tick(20);

		expect(deltaRowIds(transport).sort()).toEqual(["r1", "r2"]);
		await server.close();
	});

	test("a partially filled window keeps accepting rows up to its size", async () => {
		const { transport, server, state } = await setupWindowed(3, [{ id: "r1" }]);

		state.rows = [{ id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "r4" }];
		await server.notifyChange("messages");
		await tick(20);

		// Window of 3: r2 and r3 land, r4 is beyond the window.
		expect(deltaRowIds(transport).sort()).toEqual(["r2", "r3"]);
		await server.close();
	});

	test("load_more widens the window even when fewer rows exist", async () => {
		const { transport, server, state } = await setupWindowed(2, [{ id: "r1" }]);

		transport.messageHandler!("c1", { type: "load_more", table: "messages", count: 3 });
		await tick(20);
		transport.sentMessages.length = 0;

		// Entitlement is now 5, not loadedCount(1) + 3.
		state.rows = Array.from({ length: 8 }, (_, i) => ({ id: `r${i + 1}` }));
		await server.notifyChange("messages");
		await tick(20);

		expect(deltaRowIds(transport).sort()).toEqual(["r2", "r3", "r4", "r5"]);
		await server.close();
	});

	test("resume restores the widened window, not the initial one", async () => {
		const { transport, server } = await setupWindowed(2, [
			{ id: "r1" },
			{ id: "r2" },
			{ id: "r3" },
			{ id: "r4" },
		]);

		transport.messageHandler!("c1", { type: "load_more", table: "messages", count: 2 });
		await tick(20);
		transport.sentMessages.length = 0;

		transport.messageHandler!("c1", {
			type: "resume",
			since: packHlc({ ms: 1, counter: 0, nodeId: "server:x" }),
		});
		await tick(20);

		const snapshot = transport.sentMessages.find(
			(m) => m.message.type === "snapshot",
		)!.message as Extract<ServerMessage, { type: "snapshot" }>;
		// Re-snapshotting only `windowSize` rows would silently shrink the
		// client's view back to 2 after every reconnect.
		expect(snapshot.rows.length).toBe(4);
		await server.close();
	});

	test("window: 0 is treated as unwindowed rather than clamping to zero rows", async () => {
		const { transport, server, state } = await setupWindowed(0, [{ id: "r1" }]);

		state.rows = [{ id: "r1" }, { id: "r2" }];
		await server.notifyChange("messages");
		await tick(20);

		expect(deltaRowIds(transport)).toEqual(["r2"]);
		await server.close();
	});
});
