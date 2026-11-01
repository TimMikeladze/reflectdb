import { afterEach, describe, expect, test } from "bun:test";
import pg from "pg";
import { createMemoryStorage } from "../../src/client/storage/memory.ts";
import type { TextBinding } from "../../src/client/text.ts";
import { createSyncClient } from "../../src/client/typed-client.ts";
import { defineSyncQueries, t } from "../../src/core/index.ts";
import { MutationError } from "../../src/core/types.ts";
import { createPostgresStorage } from "../../src/server/storage/postgres.ts";
import { createSqliteStorage } from "../../src/server/storage/sqlite.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import { createBunWsServerTransport } from "../../src/transport/bun-ws.ts";
import { createWsClientTransport } from "../../src/transport/ws.ts";

type Block = {
	id: string;
	doc?: string;
	text: string;
	order: number;
	deleted: boolean;
};

const queries = defineSyncQueries({
	blocks: {
		row: t<Block>(),
		params: t<{ doc: string }>(),
		conflict: { policy: "merge", text: ["text"], softDelete: "deleted" },
	},
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 8000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error(`condition not met after ${ms}ms`);
		await sleep(10);
	}
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const clean of cleanups.splice(0).reverse()) await clean();
});

/** A delayed `mutate` stands in for a database. Instant writes hide the races worth testing. */
function createWorld(
	options: {
		delay?: number;
		oplog?: "full" | "tables";
		storage?: any;
		db?: Map<string, any>;
		poll?: number;
		reject?: (who: string) => boolean;
	} = {},
) {
	const db = options.db ?? new Map<string, any>();
	const conns: string[] = [];
	const { transport, websocket } = createBunWsServerTransport({});
	const sent: any[] = [];
	const send = transport.send.bind(transport);
	transport.send = async (id: string, message: any) => {
		sent.push({ id, message });
		return send(id, message);
	};
	const storage = options.storage ?? createSqliteStorage();
	const server: any = createSyncServer({
		queries,
		db,
		transport,
		serverId: crypto.randomUUID(),
		storage,
		...(options.poll ? { poll: options.poll } : {}),
	} as any);
	server.auth(async (req: Request) => ({
		userId: req.headers.get("authorization")?.replace("Bearer ", "") ?? "",
	}));
	server.room("doc/:doc", () => ({ ok: true }));
	server.implement("blocks", {
		room: "doc/:doc",
		groupBy: ({ params }: any) => String(params.doc),
		...(options.oplog ? { oplog: options.oplog } : {}),
		query: (ctx: any) => [...db.values()].filter((r) => r.doc === ctx.params.doc),
		mutate: async (op: any, ctx: any) => {
			if (options.reject?.(ctx.auth.userId)) throw new MutationError("mutation_rejected", "no");
			if (options.delay) await sleep(options.delay);
			db.set(op.rowId, { ...op.payload, id: op.rowId, doc: ctx.params.doc });
		},
	});
	const app = Bun.serve({
		port: 0,
		websocket: websocket as any,
		fetch(req, srv) {
			const data = { id: `c-${crypto.randomUUID().slice(0, 8)}`, req };
			conns.push(data.id);
			if (srv.upgrade(req, { data })) return undefined as any;
			return new Response("ws", { status: 426 });
		},
	});
	cleanups.push(async () => {
		await server.close?.();
		app.stop(true);
	});

	async function peer(who: string, doc = "a") {
		const client: any = createSyncClient({
			queries,
			clientId: `${who}-${crypto.randomUUID().slice(0, 6)}`,
			transport: createWsClientTransport({ url: `ws://localhost:${app.port}/` }),
			token: who,
			storage: createMemoryStorage(),
		} as any);
		cleanups.push(() => client.close().catch(() => {}));
		await client.init();
		await client.connect();
		await client.sync("blocks", { doc });
		await until(() => client.getState() === "synced");
		return client;
	}

	return { db, conns, sent, transport, storage, peer };
}

async function seed(client: any, id = "b1", text = "hello world", order = 0): Promise<void> {
	client.insert("blocks", id, { text, order, deleted: false });
	await until(() => client.getRow("blocks", id) !== null);
}

/** Type one character at the caret, as a textarea would report it. */
function type(binding: TextBinding, ch: string): void {
	const value = binding.get();
	const at = binding.caret();
	binding.set(value.slice(0, at) + ch + value.slice(at), at + ch.length);
}

async function ready(client: any, id = "b1"): Promise<TextBinding> {
	const binding = client.text("blocks", id, "text");
	cleanups.push(() => binding.close());
	await until(() => binding.ready());
	return binding;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

for (const delay of [0, 5, 25]) {
	describe(`text columns, ${delay} ms writes`, () => {
		test("someone typing alone hears back and keeps every key", async () => {
			const w = createWorld({ delay });
			const a = await w.peer("alice");
			const c = await w.peer("carol");
			await seed(a);
			const text = await ready(a);
			await until(() => c.getRow("blocks", "b1") !== null);
			text.setCaret(0);
			for (let i = 0; i < 30; i++) {
				type(text, "A");
				await sleep(20);
			}
			await until(() => c.getRow("blocks", "b1")?.text === `${"A".repeat(30)}hello world`);
			expect(text.get()).toBe(`${"A".repeat(30)}hello world`);
		});

		test("two people in one value at different places keep everything, in order", async () => {
			const w = createWorld({ delay });
			const a = await w.peer("alice");
			const b = await w.peer("bob");
			await seed(a);
			await until(() => b.getRow("blocks", "b1") !== null);
			const ta = await ready(a);
			const tb = await ready(b);
			ta.setCaret(0);
			tb.setCaret(tb.get().length);
			for (let i = 0; i < 30; i++) {
				type(ta, "A");
				type(tb, "B");
				await sleep(20);
			}
			const want = `${"A".repeat(30)}hello world${"B".repeat(30)}`;
			await until(() => ta.get() === want && tb.get() === want);
			expect(w.db.get("b1").text).toBe(want);
		});

		test("two people at one caret lose nothing and converge", async () => {
			const w = createWorld({ delay });
			const a = await w.peer("alice");
			const b = await w.peer("bob");
			await seed(a);
			await until(() => b.getRow("blocks", "b1") !== null);
			const ta = await ready(a);
			const tb = await ready(b);
			ta.setCaret(5);
			tb.setCaret(5);
			for (let i = 0; i < 20; i++) {
				type(ta, "A");
				type(tb, "B");
				await sleep(20);
			}
			await until(
				() => ta.get() === tb.get() && count(ta.get(), "A") === 20 && count(ta.get(), "B") === 20,
			);
			await until(() => w.db.get("b1").text === ta.get());
		});

		test("an edit beats a concurrent remove, whichever arrives first", async () => {
			for (const removeFirst of [true, false]) {
				const w = createWorld({ delay });
				const a = await w.peer("alice");
				const b = await w.peer("bob");
				await seed(a);
				await until(() => b.getRow("blocks", "b1") !== null);
				const ta = await ready(a);
				const tb = await ready(b);
				ta.setCaret(0);
				if (removeFirst) {
					tb.remove();
					tb.flush();
					type(ta, "E");
					ta.flush();
				} else {
					type(ta, "E");
					ta.flush();
					tb.remove();
					tb.flush();
				}
				await until(
					() =>
						w.db.get("b1")?.text === "Ehello world" &&
						!w.db.get("b1")?.deleted &&
						tb.get() === "Ehello world",
				);
			}
		});
	});
}

describe("text columns", () => {
	test("a remove that saw the latest text applies", async () => {
		const w = createWorld();
		const a = await w.peer("alice");
		const c = await w.peer("carol");
		await seed(a);
		await until(() => c.getRow("blocks", "b1") !== null);
		const text = await ready(a);
		text.remove();
		await until(() => c.getRow("blocks", "b1")?.deleted === true);
	});

	test("edits made while the socket is down land after reconnecting", async () => {
		const w = createWorld({ delay: 5 });
		const a = await w.peer("alice");
		const b = await w.peer("bob");
		await seed(a);
		await until(() => b.getRow("blocks", "b1") !== null);
		const ta = await ready(a);
		const tb = await ready(b);
		ta.setCaret(0);
		tb.setCaret(tb.get().length);
		w.transport.disconnect(w.conns[1]!);
		for (let i = 0; i < 10; i++) {
			type(ta, "A");
			type(tb, "B");
			await sleep(20);
		}
		const want = `${"A".repeat(10)}hello world${"B".repeat(10)}`;
		await until(() => ta.get() === want && tb.get() === want, 12000);
	}, 20000);

	test("two clients seeding one id leave one row, and a late joiner gets the text", async () => {
		const w = createWorld({ delay: 5 });
		const a = await w.peer("alice");
		const b = await w.peer("bob");
		a.insert("blocks", "sha:0", { text: "seed", order: 0, deleted: false });
		b.insert("blocks", "sha:0", { text: "seed", order: 0, deleted: false });
		await until(() => w.db.has("sha:0"));
		const text = await ready(a, "sha:0");
		text.setCaret(4);
		type(text, "!");
		await until(() => w.db.get("sha:0")?.text === "seed!");
		const late = await w.peer("erin");
		await until(() => late.getRow("blocks", "sha:0")?.text === "seed!");
		expect(late.getRows("blocks").length).toBe(1);
	});

	test("large values go out as patches that rebuild the same text", async () => {
		const w = createWorld();
		const a = await w.peer("alice");
		const c = await w.peer("carol");
		const big = "lorem ipsum ".repeat(200);
		await seed(a, "b1", big);
		await until(() => c.getRow("blocks", "b1") !== null);
		const text = await ready(a);
		text.setCaret(0);
		w.sent.length = 0;
		type(text, "X");
		await until(() => c.getRow("blocks", "b1")?.text === `X${big}`);
		const toCarol = w.sent.filter((s) => s.message.type === "delta" && s.message.textPatches);
		expect(toCarol.length).toBeGreaterThan(0);
		expect(JSON.stringify(toCarol[0].message).length).toBeLessThan(500);
	});

	test("a patch that doesn't apply makes the client bootstrap", async () => {
		const w = createWorld();
		const a = await w.peer("alice");
		await seed(a, "b1", "x".repeat(400));
		const text = await ready(a);
		const originalSend = w.transport.send;
		let corrupted = false;
		w.transport.send = async (id: string, message: any) => {
			if (message.type === "delta" && message.textPatches && !corrupted) {
				corrupted = true;
				for (const patch of Object.values<any>(message.textPatches)) patch.hash = 1;
			}
			return originalSend(id, message);
		};
		const c = await w.peer("carol");
		await until(() => c.getRow("blocks", "b1") !== null);
		text.setCaret(0);
		type(text, "Y");
		await until(() => c.getRow("blocks", "b1")?.text === `Y${"x".repeat(400)}`);
		expect(corrupted).toBe(true);
	});

	test('oplog: "tables" keeps no text in the op log, and resume still works', async () => {
		const storage = createSqliteStorage();
		const w = createWorld({ oplog: "tables", storage });
		const a = await w.peer("alice");
		await seed(a);
		const text = await ready(a);
		text.setCaret(0);
		type(text, "S");
		await until(() => w.db.get("b1")?.text === "Shello world");
		const ops = await storage.getOpsSince("0", ["blocks"]);
		expect(ops.length).toBeGreaterThan(0);
		expect(ops.every((op) => op.payload === null)).toBe(true);
	});

	test("a refused edit puts the text back and reports it", async () => {
		const w = createWorld({ reject: (who) => who === "bob" });
		const a = await w.peer("alice");
		const b = await w.peer("bob");
		await seed(a);
		await until(() => b.getRow("blocks", "b1") !== null);
		const reasons: string[] = [];
		const text = b.text("blocks", "b1", "text", { onError: (r: string) => reasons.push(r) });
		cleanups.push(() => text.close());
		await until(() => text.ready());
		text.setCaret(0);
		type(text, "N");
		await until(() => reasons.length > 0);
		expect(reasons[0]).toBe("mutation_rejected");
		expect(text.get()).toBe("hello world");
	});

	test("hunks with out-of-range offsets are refused", async () => {
		const w = createWorld();
		const a = await w.peer("alice");
		await seed(a);
		a.update("blocks", "b1", {
			$text: { who: "x", n: 1, edits: { text: { value: "a", back: [[5, 2, ""]] } } },
		});
		await sleep(100);
		expect(w.db.get("b1").text).toBe("hello world");
	});

	test("text columns refuse an eager broadcast", () => {
		const { transport } = createBunWsServerTransport({});
		const server: any = createSyncServer({
			queries,
			db: new Map(),
			transport,
			serverId: "s",
		} as any);
		expect(() =>
			server.implement("blocks", { query: () => [], mutate: async () => {}, broadcast: "eager" }),
		).toThrow(/consistent broadcast/);
	});
});

describe("client.sync after connect", () => {
	test("changing params swaps the rows", async () => {
		const w = createWorld();
		const a = await w.peer("alice", "a");
		await seed(a, "in-a");
		const b = await w.peer("bob", "b");
		await seed(b, "in-b");
		await a.sync("blocks", { doc: "b" });
		await until(() => a.getRow("blocks", "in-b") !== null);
		expect(a.getRow("blocks", "in-a")).toBeNull();
	});
});

describe("eager inserts", () => {
	test("a later server delete reaches peers that got the row eagerly", async () => {
		const eager = defineSyncQueries({ items: { row: t<{ id: string; v: number }>() } });
		const db = new Map<string, any>();
		const { transport, websocket } = createBunWsServerTransport({});
		const server: any = createSyncServer({
			queries: eager,
			db,
			transport,
			serverId: "eager",
			storage: createSqliteStorage(),
		} as any);
		server.auth(async () => ({ userId: "u" }));
		server.implement("items", {
			broadcast: "eager-durable",
			query: () => [...db.values()],
			mutate: async (op: any) => {
				db.set(op.rowId, { id: op.rowId, ...op.payload });
			},
		});
		const app = Bun.serve({
			port: 0,
			websocket: websocket as any,
			fetch(req, srv) {
				if (srv.upgrade(req, { data: { id: crypto.randomUUID(), req } })) return undefined as any;
				return new Response("ws", { status: 426 });
			},
		});
		cleanups.push(async () => {
			await server.close?.();
			app.stop(true);
		});
		const peer = async (name: string) => {
			const client: any = createSyncClient({
				queries: eager,
				clientId: name,
				transport: createWsClientTransport({ url: `ws://localhost:${app.port}/` }),
				token: "t",
				storage: createMemoryStorage(),
			} as any);
			cleanups.push(() => client.close().catch(() => {}));
			await client.init();
			await client.connect();
			await client.sync("items");
			await until(() => client.getState() === "synced");
			return client;
		};
		const writer = await peer("writer");
		const watcher = await peer("watcher");
		writer.insert("items", "gone", { v: 1 });
		await until(() => watcher.getRow("items", "gone") !== null);
		db.delete("gone");
		await server.notifyChange("items");
		await until(() => watcher.getRow("items", "gone") === null);
	});
});

const POSTGRES_URL = process.env.REFLECTDB_TEST_POSTGRES_URL;
const describePostgres = POSTGRES_URL ? describe : describe.skip;

describePostgres("text columns on Postgres, two servers", () => {
	test("merges stay correct when two machines write one row", async () => {
		const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 8 });
		cleanups.push(() => pool.end());
		const prefix = `t${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
		const db = new Map<string, any>();
		const storage = createPostgresStorage({ client: pool as any, tablePrefix: prefix });
		const one = createWorld({ storage, db, poll: 100, delay: 5 });
		const two = createWorld({ storage, db, poll: 100, delay: 5 });
		const a = await one.peer("alice");
		const b = await two.peer("bob");
		await seed(a);
		await until(() => b.getRow("blocks", "b1") !== null, 15000);
		const ta = await ready(a);
		const tb = await ready(b);
		ta.setCaret(0);
		tb.setCaret(tb.get().length);
		for (let i = 0; i < 15; i++) {
			type(ta, "A");
			type(tb, "B");
			await sleep(60);
		}
		const want = `${"A".repeat(15)}hello world${"B".repeat(15)}`;
		await until(() => ta.get() === want && tb.get() === want, 30000);
		expect(db.get("b1").text).toBe(want);
	}, 60000);

	test("applyOpIf writes only when the row is what was read", async () => {
		const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 2 });
		cleanups.push(() => pool.end());
		const prefix = `t${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
		const storage: any = createPostgresStorage({ client: pool as any, tablePrefix: prefix });
		expect(
			await storage.applyOpIf("t", "r", { v: 1 }, { _row: "h1" }, "h1", "insert", null, null),
		).toBe(true);
		expect(
			await storage.applyOpIf("t", "r", { v: 2 }, { _row: "h2" }, "h2", "insert", null, null),
		).toBe(false);
		expect(
			await storage.applyOpIf("t", "r", { v: 3 }, { _row: "h3" }, "h3", "update", null, "nope"),
		).toBe(false);
		expect(
			await storage.applyOpIf("t", "r", { v: 4 }, { _row: "h4" }, "h4", "update", { v: 4 }, "h1"),
		).toBe(true);
		expect((await storage.getRow("t", "r")).row).toEqual({ v: 4 });
		expect((await storage.getOpsSince("0", ["t"])).length).toBe(2);
		expect(await storage.applyOpIf("t", "r", null, {}, "h5", "delete", null, "h4")).toBe(true);
		expect((await storage.getRow("t", "r")).row).toBeNull();
	}, 30000);
});
