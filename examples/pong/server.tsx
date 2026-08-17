/**
 * Infinite-player pong — server.
 *
 * The arena is a circle. Every connected player owns one arc of the rim and
 * defends it with a paddle; the rim re-partitions the instant somebody joins or
 * drops. The server owns the ball, so there is nothing to reconcile: paddles
 * flow up as ordinary sync writes, ball state flows down as deltas.
 *
 * State lives in plain Maps. reflectdb never asks what your store is — `db` is
 * whatever you hand `createSyncServer`, and `query`/`mutate` get it back
 * untouched.
 */

import { serve } from "bun";
import { MutationError } from "../../src/core/index.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import { createBunWsServerTransport } from "../../src/transport/bun-ws.ts";
import { createArena, ensureBalls, reap, step } from "./physics.ts";
import type { Arena, Hit } from "./physics.ts";
import { MAX_NAME_LEN, TICK_MS, norm, queries } from "./schema.ts";
import type { AppAuth, Standing } from "./schema.ts";

// ── World state (this is the "database") ────────────────────────────────

interface World {
	games: Map<string, Arena>;
}

const world: World = { games: new Map() };

function arena(w: World, gameId: string): Arena {
	let a = w.games.get(gameId);
	if (!a) {
		a = createArena(gameId);
		w.games.set(gameId, a);
	}
	return a;
}

const roomKey = (gameId: string) => `game/${gameId}`;

// ── Client bundle ───────────────────────────────────────────────────────

// Rebuilt per request. `bun --hot --watch` reloads this file, but app.tsx and
// the client half of schema.ts are only reachable through the browser bundle —
// without this, editing the UI would need a manual restart.
async function buildClient(): Promise<string> {
	const result = await Bun.build({
		entrypoints: [import.meta.dir + "/render.tsx"],
		target: "browser",
		minify: false,
	});
	return result.outputs[0]!.text();
}

async function clientHtml(): Promise<string> {
	const raw = await Bun.file(import.meta.dir + "/index.html").text();
	return raw.replace(
		'<script type="module" src="./render.tsx"></script>',
		'<script type="module" src="/app.js"></script>',
	);
}

// ── Sync server ─────────────────────────────────────────────────────────

const { transport, websocket } = createBunWsServerTransport({
	maxMessageBytes: 64_000,
	pingIntervalMs: 30_000,
});

const server = createSyncServer<typeof queries, World, AppAuth>({
	queries,
	db: world,
	transport,
	serverId: "pong",
	maxConnectionsPerUser: 4,
	queryTimeoutMs: 2_000,
});

// No accounts here: the token IS the player id, generated and kept by the
// browser. Everything downstream keys on it — rate limits, connection caps,
// row ownership.
server.auth(async (req) => {
	const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
	if (!/^p_[a-z0-9]{6,32}$/.test(token)) throw new Error("bad player token");
	return { userId: token };
});

// Paddle writes are chatty by design — a moving pointer sends ~60 ops/s, and a
// rejected op would snap the paddle back. Budget above the client's own cap.
server.rateLimit({
	opsPerSecond: 150,
	opsPerMinute: 8_000,
	perTable: { players: { opsPerSecond: 120 } },
	ephemeralPerSecond: 8,
});

// One arena per room. Every query below requires this pattern, so a
// subscription that doesn't resolve it is refused rather than quietly
// widening into "all arenas".
server.room("game/:gameId", ({ params }) => {
	if (!/^[a-z0-9_-]{1,24}$/i.test(params.gameId)) {
		return { ok: false, reason: "arena names are 1-24 chars of [a-z0-9_-]" };
	}
});

server.implement("players", {
	query: (ctx, w) => [...arena(w, ctx.params.gameId).players.values()],

	// All members of an arena see identical rows, so one execution serves the
	// whole room instead of one per connected player.
	groupBy: ({ params }) => String(params.gameId),
	room: "game/:gameId",

	// Paddles are single-writer — only you move yours — so there is no conflict
	// worth resolving, and the consistent path's re-query-and-diff is pure
	// latency. Eager forwards the delta the moment `mutate` returns, and it
	// forwards EVERY op rather than one collapsed broadcast per batch, which is
	// what gives the client enough samples to interpolate between.
	broadcast: "eager-durable",

	serverSet: {
		// Never trust a client's idea of which arena its row belongs to.
		gameId: (ctx) => ctx.params.gameId,
		// Applied on every write, so moving your paddle is also your heartbeat.
		lastSeen: () => Date.now(),
	},

	mutate: async (op, ctx, w) => {
		const a = arena(w, ctx.params.gameId);

		// A paddle belongs to exactly one connection.
		if (op.rowId !== ctx.auth.userId) {
			throw new MutationError("mutation_rejected", "you can only move your own paddle");
		}

		if (op.type === "delete") {
			a.players.delete(op.rowId);
			return;
		}

		const payload = op.payload ?? {};
		const prev = a.players.get(op.rowId);
		const rawName = typeof payload.name === "string" ? payload.name.trim() : "";

		a.players.set(op.rowId, {
			id: op.rowId,
			gameId: ctx.params.gameId,
			name: (rawName || prev?.name || `guest-${op.rowId.slice(2, 6)}`).slice(0, MAX_NAME_LEN),
			angle:
				typeof payload.angle === "number" && Number.isFinite(payload.angle)
					? norm(payload.angle)
					: (prev?.angle ?? 0),
			// `readonly` strips these from updates, but NOT from inserts — so the
			// authoritative values are re-derived here on every write.
			score: prev?.score ?? 0,
			misses: prev?.misses ?? 0,
			joinedAt: prev?.joinedAt ?? Date.now(),
			lastSeen: Date.now(),
		});
	},
});

server.implement("balls", {
	query: (ctx, w) => [...arena(w, ctx.params.gameId).balls.values()],
	groupBy: ({ params }) => String(params.gameId),
	room: "game/:gameId",
	mutate: async () => {
		throw new MutationError("readonly_query", "the ball belongs to the server");
	},
});

server.view("standings", (ctx, w): Standing[] =>
	[...arena(w, ctx.params.gameId).players.values()]
		.sort((x, y) => y.score - x.score || x.misses - y.misses)
		.slice(0, 12)
		.map((p, i) => ({
			id: p.id,
			name: p.name,
			score: p.score,
			misses: p.misses,
			rank: i + 1,
		})),
);

// ── Physics loop ────────────────────────────────────────────────────────
//
// `server.interval` clears itself on close and on `bun --hot` reload, so an
// edit-save cycle never leaves two loops fighting over the same arena.
// `tryLock` skips a tick outright when the previous one is still fanning out,
// which is the behaviour you want under load — late frames, not a backlog.

server.interval(TICK_MS, async () => {
	await server.tryLock("tick", async () => {
		const now = Date.now();

		for (const [gameId, a] of world.games) {
			if (reap(a, now) > 0) {
				await server.notifyChange("players", roomKey(gameId));
			}

			if (a.players.size === 0) {
				if (a.balls.size > 0) {
					a.balls.clear();
					await server.notifyChange("balls", roomKey(gameId));
				}
				world.games.delete(gameId);
				continue;
			}

			ensureBalls(a);

			const dt = Math.min((now - a.lastTick) / 1000, 0.1);
			a.lastTick = now;

			const hits = step(a, dt);

			// One broadcast per arena per tick. The engine re-runs the balls query
			// once for the whole room and diffs each subscriber's cached result,
			// so only the coordinates that actually moved go on the wire.
			await server.notifyChange("balls", roomKey(gameId));

			// Fold multiple hits on one player (two balls, same tick) before writing.
			const folded = new Map<string, Hit>();
			for (const hit of hits) {
				const cur = folded.get(hit.id) ?? { id: hit.id, score: 0, misses: 0 };
				folded.set(hit.id, {
					id: hit.id,
					score: cur.score + hit.score,
					misses: cur.misses + hit.misses,
				});
			}

			for (const delta of folded.values()) {
				const p = a.players.get(delta.id);
				if (!p) continue;
				// Server-origin write: applyServerOp stamps the HLC, hands it to
				// `execute` for our own store, then commits reflectdb's mirror and
				// broadcasts — keeping both stores in step, which a bare
				// notifyChange would not.
				await server.applyServerOp(
					{
						type: "update",
						table: "players",
						rowId: p.id,
						payload: { score: p.score + delta.score, misses: p.misses + delta.misses },
					},
					async (stamped) => {
						Object.assign(p, stamped.payload);
					},
					{ roomKey: roomKey(gameId) },
				);
			}
		}
	});
});

// ── HTTP ────────────────────────────────────────────────────────────────

const httpServer = serve({
	port: 3004,
	websocket,
	async fetch(req, srv) {
		const url = new URL(req.url);

		if (url.pathname === "/sync") {
			if (srv.upgrade(req, { data: { id: `ws-${crypto.randomUUID().slice(0, 8)}`, req } })) {
				return;
			}
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		if (url.pathname === "/app.js") {
			return new Response(await buildClient(), {
				headers: { "content-type": "application/javascript", "cache-control": "no-store" },
			});
		}

		return new Response(await clientHtml(), {
			headers: { "content-type": "text/html", "cache-control": "no-store" },
		});
	},
});

console.log(`Pong running at http://localhost:${httpServer.port}`);
