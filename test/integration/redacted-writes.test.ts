import { describe, expect, test } from "bun:test";
import { SyncClient } from "../../src/client/sync-client.ts";
import { ClientStore } from "../../src/client/store.ts";
import { createOpCreator } from "../../src/client/ops.ts";
import { defineSyncQueries, MutationError, t } from "../../src/core/index.ts";
import type { ClientTransport, ServerMessage } from "../../src/core/types.ts";
import { createSyncServer } from "../../src/server/index.ts";
import { createWsServerTransport } from "../../src/transport/ws.ts";

/**
 * A server whose query is per user and whose database is a plain Map with no
 * `db` handle: the shape of a game where the server hides things.
 */
type Card = { id: string; owner: string; face: string | null };

function setup() {
	const cards = new Map<string, Card>();
	const transport = createWsServerTransport({ pingIntervalMs: 0 });
	const server = createSyncServer({
		queries: defineSyncQueries({ cards: { row: t<Card>(), conflict: "lww" } }),
		transport,
		serverId: "s",
	});
	server.auth(async (req) => ({
		userId: req.headers.get("authorization")!.replace("Bearer ", ""),
	}));
	server.implement("cards", {
		// Everyone sees every card; only its owner sees the face.
		query: (ctx) =>
			[...cards.values()].map((c) => (c.owner === ctx.auth.userId ? c : { ...c, face: null })),
		mutate: async (op, ctx) => {
			const cur = cards.get(op.rowId);
			if (cur && cur.owner !== ctx.auth.userId) throw new MutationError("mutation_rejected", "not yours");
			if (op.type === "delete") cards.delete(op.rowId);
			else cards.set(op.rowId, { ...cur, ...(op.payload as Card), id: op.rowId });
		},
	});

	const seen = new Map<string, ServerMessage[]>();
	const connect = (user: string, config: { autoPush?: boolean } = {}) => {
		let handler: ((m: ServerMessage) => void) | null = null;
		const ws = {
			send: (data: string) => {
				const msg = JSON.parse(data) as ServerMessage;
				seen.get(user)!.push(msg);
				queueMicrotask(() => handler?.(msg));
			},
			close: () => {},
		};
		seen.set(user, []);
		transport.handleOpen(user, ws);
		const client: ClientTransport = {
			async send(m) {
				transport.handleMessage(user, JSON.stringify(m));
			},
			subscribe(h) {
				handler = h;
			},
			async close() {},
		};
		return new SyncClient({ clientId: user, transport: client, token: user, ...config });
	};
	return { cards, server, connect, seen };
}

const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
};

describe("per-user queries without a db", () => {
	test("sync() before connect(), no push(): rows arrive and writes land", async () => {
		const { connect, cards } = setup();
		const a = connect("alice");
		await a.sync("cards"); // before the handshake
		await a.connect();
		a.insert("cards", "c1", { owner: "alice", face: "A♠" }); // no push()
		await settle();
		expect(cards.get("c1")?.face).toBe("A♠");
		expect(a.getState()).toBe("synced");
		expect(a.getRow("cards", "c1")?.face).toBe("A♠");
	});

	test("a refused write rolls back to what the writer was shown, never the stored row", async () => {
		const { connect, seen } = setup();
		const a = connect("alice");
		const b = connect("bob");
		for (const c of [a, b]) {
			await c.sync("cards");
			await c.connect();
		}
		a.insert("cards", "c1", { owner: "alice", face: "A♠" });
		await settle();
		expect(b.getRow("cards", "c1")?.face).toBeNull();

		b.update("cards", "c1", { owner: "bob" });
		await settle();
		const reject = seen.get("bob")!.find((m) => m.type === "reject") as
			| { serverRow?: Record<string, unknown> | null }
			| undefined;
		expect(reject).toBeDefined();
		expect(JSON.stringify(reject)).not.toContain("A♠");
		expect(b.getRow("cards", "c1")).toMatchObject({ owner: "alice", face: null });
	});
});

describe("reverting with several ops on one row in flight", () => {
	const row = (store: ClientStore) => store.getRow("t", "r1")?.data;

	function seeded() {
		const store = new ClientStore();
		store.setRow("t", "r1", { id: "r1", a: 0, b: 0 }, {}, null);
		const ops = createOpCreator("n");
		return { store, ops };
	}

	test("both refused: back to the original row", () => {
		const { store, ops } = seeded();
		const one = ops.update("t", "r1", { a: 1 });
		store.addPendingOp(one);
		store.applyOptimistic(one);
		const two = ops.update("t", "r1", { b: 2 });
		store.addPendingOp(two);
		store.applyOptimistic(two);
		store.revertOp(one.id, null);
		store.revertOp(two.id, null);
		expect(row(store)).toEqual({ id: "r1", a: 0, b: 0 });
	});

	test("first refused, second still pending: the second stays applied", () => {
		const { store, ops } = seeded();
		const one = ops.update("t", "r1", { a: 1 });
		store.addPendingOp(one);
		store.applyOptimistic(one);
		const two = ops.update("t", "r1", { b: 2 });
		store.addPendingOp(two);
		store.applyOptimistic(two);
		store.revertOp(one.id, null);
		expect(row(store)).toEqual({ id: "r1", a: 0, b: 2 });
		// And refusing the second later lands on the original, not on `a: 1`.
		store.revertOp(two.id, null);
		expect(row(store)).toEqual({ id: "r1", a: 0, b: 0 });
	});
});
