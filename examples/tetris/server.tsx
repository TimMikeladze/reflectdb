/**
 * Infinite-player Tetris — one perpetual, server-authoritative game.
 *
 * Each connection owns one well. There are no rooms or rounds: people can join
 * and leave at any time, and a top-out immediately starts that player again at
 * zero. Bun SQLite persists the authoritative wells and reflectdb sync log.
 */

import { serve } from "bun";
import { MutationError } from "../../src/core/index.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import { createBunWsServerTransport } from "../../src/transport/bun-ws.ts";
import { TetrisDatabase } from "./database.ts";
import { advancePlayer, applyInput, createPlayer, publicPlayer, randomName } from "./game.ts";
import { IDLE_TIMEOUT_MS, TICK_MS, queries } from "./schema.ts";
import type { AppAuth, InputAction, Standing } from "./schema.ts";

const databasePath = process.env.TETRIS_DB_PATH ?? `${import.meta.dir}/tetris.db`;
const database = new TetrisDatabase(databasePath);

async function buildClient(): Promise<string> {
	if (process.env.NODE_ENV === "production") {
		return Bun.file(import.meta.dir + "/app.js").text();
	}
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

const { transport, websocket } = createBunWsServerTransport({
	maxMessageBytes: 64_000,
	pingIntervalMs: 30_000,
});

const server = createSyncServer<typeof queries, TetrisDatabase, AppAuth>({
	queries,
	db: database,
	transport,
	storage: database.storage,
	serverId: "tetris",
	maxConnectionsPerUser: 4,
	queryTimeoutMs: 2_000,
});

server.auth(async (req) => {
	const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
	if (!/^p_[a-z0-9]{6,32}$/.test(token)) throw new Error("bad player token");
	return { userId: token };
});

server.rateLimit({
	opsPerSecond: 160,
	opsPerMinute: 6_000,
	perTable: { players: { opsPerSecond: 120 } },
});

// A Tetris mutation is only a tiny input command; the database expands it into
// the complete authoritative board. reflectdb normally excludes a writer from
// its own broadcast because that client already applied the command
// optimistically. Re-query once after the accepted op so the writer receives
// the server-owned result too. Coalescing keeps held-key input bursts to one
// reconciliation query per event-loop turn.
let reconciliationQueued = false;
function queuePlayerReconciliation(): void {
	if (reconciliationQueued) return;
	reconciliationQueued = true;
	setTimeout(async () => {
		reconciliationQueued = false;
		try {
			await server.notifyChange("players");
		} catch (error) {
			console.error("Tetris reconciliation failed:", error);
		}
	}, 0);
}

const ACTIONS = new Set<InputAction>([
	"join",
	"heartbeat",
	"left",
	"right",
	"rotate-cw",
	"rotate-ccw",
	"soft-drop",
	"hard-drop",
]);

function isAction(value: unknown): value is InputAction {
	return typeof value === "string" && ACTIONS.has(value as InputAction);
}

server.implement("players", {
	query: (_ctx, db) => db.listPlayers().map(publicPlayer),

	// Every subscriber sees the same perpetual game, independent of auth. This
	// collapses each tick to one query execution even as the crowd grows.
	groupBy: () => "global-game",

	serverSet: {
		lastSeen: () => Date.now(),
	},

	mutate: async (op, ctx, db) => {
		if (op.rowId !== ctx.auth.userId) {
			throw new MutationError("mutation_rejected", "you can only control your own well");
		}

		if (op.type === "delete") {
			db.deletePlayer(op.rowId);
			return;
		}

		db.transaction(() => {
			let player = db.getPlayer(op.rowId);
			if (!player) {
				const name = randomName(db.listPlayers().map((candidate) => candidate.name));
				player = createPlayer(op.rowId, name);
			}

			const payload = op.payload ?? {};
			const seq = payload.inputSeq;
			const action = payload.action;
			player.lastSeen = Date.now();

			if (Number.isSafeInteger(seq) && typeof seq === "number" && seq > player.processedSeq) {
				if (!isAction(action)) {
					throw new MutationError("mutation_rejected", "unknown Tetris input");
				}
				player.inputSeq = seq;
				player.processedSeq = seq;
				player.action = action;
				applyInput(player, action);
			}

			db.savePlayer(player);
		});
		queuePlayerReconciliation();
	},
});

server.view("standings", (_ctx, db): Standing[] =>
	db
		.listPlayers()
		.sort((a, b) => b.score - a.score || b.lines - a.lines || a.joinedAt - b.joinedAt)
		.slice(0, 20)
		.map((player, index) => ({
			id: player.id,
			name: player.name,
			score: player.score,
			lines: player.lines,
			deaths: player.deaths,
			rank: index + 1,
		})),
);

let lastTick = Date.now();
server.interval(TICK_MS, async () => {
	await server.tryLock("tetris-tick", async () => {
		const now = Date.now();
		const elapsed = now - lastTick;
		lastTick = now;
		let changed = false;

		database.transaction(() => {
			changed = database.reapPlayers(now - IDLE_TIMEOUT_MS) > 0;
			for (const player of database.listPlayers()) {
				if (!advancePlayer(player, elapsed)) continue;
				database.savePlayer(player);
				changed = true;
			}
		});

		if (changed) await server.notifyChange("players");
	});
});

const httpServer = serve({
	port: Number(process.env.PORT ?? 3004),
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

console.log(`Tetris running at http://localhost:${httpServer.port}`);

if (process.env.NODE_ENV === "production") {
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`Received ${signal}; closing Tetris cleanly`);
		await httpServer.stop(true);
		await server.close();
		database.close();
		process.exit(0);
	};
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
	process.once("SIGINT", () => void shutdown("SIGINT"));
}
