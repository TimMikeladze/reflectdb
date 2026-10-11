/**
 * Huddle — sticky notes, live cursors and a video call, with the high-rate
 * traffic going peer-to-peer over WebRTC. See README.md.
 *
 * The server is an ordinary reflectdb sync server. It never sees a video frame
 * and only a throttled trickle of cursor frames; what it does carry is the
 * WebRTC signaling (offers, answers, ICE candidates) as `signal` messages.
 */

import { serve } from "bun";
import { MutationError } from "../../src/core/index.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import { createBunWsServerTransport } from "../../src/transport/bun-ws.ts";
import { cloudflareTurn, sharedSecretTurn } from "../../src/server/turn.ts";
import type { IceServerProvider } from "../../src/server/types.ts";
import {
	MAX_NOTES_PER_ROOM,
	MAX_ROOMS,
	ROOM_IDLE_MS,
	applyNoteWrite,
	isNoteId,
	isRoomId,
	queries,
} from "./schema.ts";
import type { Note } from "./schema.ts";

/** roomId → note id → note. Everything is in memory; an idle Machine stops and takes it along. */
type Db = Map<string, Map<string, Note>>;
const rooms: Db = new Map();
/** Last read or write per room, for idle eviction. */
const lastActive = new Map<string, number>();

const { transport, websocket } = createBunWsServerTransport({
	maxMessageBytes: 64_000,
	pingIntervalMs: 30_000,
});

const server = createSyncServer<typeof queries, Db>({
	queries,
	db: rooms,
	transport,
	serverId: "huddle",
	maxConnectionsPerUser: 8,
});

server.auth(async (req) => {
	const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
	if (!/^g_[a-z0-9]{6,32}$/.test(token)) throw new Error("bad guest token");
	return { userId: token };
});

// The room is what scopes signaling: two tabs only ever connect peer-to-peer
// when they subscribe to the same `huddle/<roomId>`.
server.room("huddle/:roomId", ({ params }) =>
	isRoomId(params.roomId) ? { ok: true } : { ok: false, reason: "invalid room" },
);

server.rateLimit({ opsPerSecond: 40, opsPerMinute: 1_200 });

// ── TURN ───────────────────────────────────────────────────────────────

/**
 * Whichever TURN the environment configures; none is hardcoded. Without one,
 * meshes fall back to public STUN, which connects most peers but not those
 * behind strict NATs, and "relay only" stays off.
 */
function turnFromEnv(): IceServerProvider | null {
	const env = process.env;
	if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
		return cloudflareTurn({
			keyId: env.CLOUDFLARE_TURN_KEY_ID,
			apiToken: env.CLOUDFLARE_TURN_API_TOKEN,
		});
	}
	if (env.TURN_URLS && env.TURN_SHARED_SECRET) {
		return sharedSecretTurn({ urls: env.TURN_URLS.split(","), secret: env.TURN_SHARED_SECRET });
	}
	return null;
}

const turn = turnFromEnv();
if (turn) server.iceServers(turn);
console.log(turn ? "[huddle] TURN configured" : "[huddle] no TURN configured; STUN only");

server.implement("notes", {
	room: "huddle/:roomId",
	query: (ctx, db) => {
		if (db.has(ctx.params.roomId)) lastActive.set(ctx.params.roomId, Date.now());
		return [...(db.get(ctx.params.roomId)?.values() ?? [])];
	},
	mutate: async (op, ctx, db) => {
		const roomId = ctx.params.roomId;
		// Checked before anything is stored: the id becomes a Map key.
		if (!isNoteId(op.rowId)) throw new MutationError("mutation_rejected", "invalid note id");
		let room = db.get(roomId);
		lastActive.set(roomId, Date.now());
		if (op.type === "delete") {
			room?.delete(op.rowId);
			return;
		}
		if (!room) {
			if (db.size >= MAX_ROOMS) throw new MutationError("mutation_rejected", "the demo is full");
			room = new Map();
			db.set(roomId, room);
		}
		const existing = room.get(op.rowId);
		if (!existing && room.size >= MAX_NOTES_PER_ROOM) {
			throw new MutationError(
				"mutation_rejected",
				`a room holds at most ${MAX_NOTES_PER_ROOM} notes`,
			);
		}
		const note = applyNoteWrite(existing, op.rowId, roomId, (op.payload ?? {}) as Partial<Note>);
		if (typeof note === "string") throw new MutationError("mutation_rejected", note);
		room.set(op.rowId, note);
	},
});

// ── Idle rooms ─────────────────────────────────────────────────────────

/**
 * Clear rooms nobody has touched for ROOM_IDLE_MS. Guest tokens are free to
 * mint, so without this one visitor could fill MAX_ROOMS and lock everyone out
 * until the Machine restarts. Deletes go through applyServerOp so a tab still
 * open on an idle room sees its notes go, rather than diverging.
 */
async function evictIdleRooms(): Promise<void> {
	const cutoff = Date.now() - ROOM_IDLE_MS;
	for (const [roomId, room] of rooms) {
		if ((lastActive.get(roomId) ?? 0) >= cutoff) continue;
		for (const id of Array.from(room.keys())) {
			await server.applyServerOp(
				{ type: "delete", table: "notes", rowId: id, payload: null },
				async () => {
					room.delete(id);
				},
				{ roomKey: `huddle/${roomId}` },
			);
		}
		rooms.delete(roomId);
		lastActive.delete(roomId);
	}
}

server.interval(5 * 60_000, () => {
	evictIdleRooms().catch((err) => console.error("[huddle] idle eviction failed:", err));
});

// ── /stats: the server's side of the throttle ──────────────────────────

/**
 * Cursor frames each connection sent through the server, per second. The page
 * shows this next to what it sent in total, which is the whole point of the
 * demo: the difference went peer-to-peer.
 */
const cursorRates = new Map<string, { second: number; count: number; last: number }>();

function countCursorFrame(clientId: string): void {
	const second = Math.floor(Date.now() / 1000);
	const rate = cursorRates.get(clientId);
	if (!rate) {
		cursorRates.set(clientId, { second, count: 1, last: 0 });
		return;
	}
	if (rate.second !== second) {
		rate.last = rate.second === second - 1 ? rate.count : 0;
		rate.second = second;
		rate.count = 0;
	}
	rate.count++;
}

function lastSecond(clientId: string): number {
	const rate = cursorRates.get(clientId);
	if (!rate) return 0;
	const second = Math.floor(Date.now() / 1000);
	if (rate.second === second) return rate.last;
	return rate.second === second - 1 ? rate.count : 0;
}

type WsData = { id: string; req: Request };
type Ws = Parameters<typeof websocket.message>[0];
const decoder = new TextDecoder();

const countingWebsocket = {
	...websocket,
	message(ws: Ws, message: string | Uint8Array) {
		// A substring test before anything else: most messages are not cursor
		// frames, and this runs on every one.
		const text = typeof message === "string" ? message : decoder.decode(message);
		if (text.includes('"key":"cursor"') && text.includes('"type":"ephemeral"')) {
			countCursorFrame(ws.data.id);
		}
		websocket.message(ws, message);
	},
	close(ws: Ws) {
		cursorRates.delete(ws.data.id);
		websocket.close(ws);
	},
};

// ── Client bundle ──────────────────────────────────────────────────────

let prebuilt: string | null = null;

async function buildClient(): Promise<string> {
	// Built once at image build time in production (see the Dockerfile); rebuilt
	// per request in dev so `bun --hot` picks up edits to app.tsx.
	if (process.env.NODE_ENV === "production") {
		prebuilt ??= await Bun.file(`${import.meta.dir}/app.js`).text();
		return prebuilt;
	}
	const result = await Bun.build({
		entrypoints: [`${import.meta.dir}/app.tsx`],
		target: "browser",
		minify: false,
	});
	if (!result.success) throw new AggregateError(result.logs, "client bundle failed");
	return (await result.outputs[0]?.text()) ?? "";
}

// ── HTTP ───────────────────────────────────────────────────────────────

/** First free port at or above the requested one, never one another app holds. */
function listen(startPort: number, options: Parameters<typeof serve>[0]) {
	for (let port = startPort; port < startPort + 20; port++) {
		try {
			return serve({ ...options, port } as Parameters<typeof serve>[0]);
		} catch (error) {
			if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
		}
	}
	throw new Error(`no free port in ${startPort}..${startPort + 19}`);
}

const app = listen(Number(process.env.PORT ?? 3006), {
	websocket: countingWebsocket,
	async fetch(request: Request, bunServer: { upgrade: (r: Request, o: unknown) => boolean }) {
		const url = new URL(request.url);

		if (url.pathname === "/sync") {
			const data: WsData = { id: `ws-${crypto.randomUUID().slice(0, 8)}`, req: request };
			if (bunServer.upgrade(request, { data })) return;
			return new Response("expected a websocket upgrade", { status: 426 });
		}

		if (url.pathname === "/config") {
			return Response.json({ turn: turn !== null });
		}

		if (url.pathname === "/stats") {
			const id = url.searchParams.get("id") ?? "";
			return Response.json({ cursorPerSecond: lastSecond(id) });
		}

		if (url.pathname === "/app.js") {
			return new Response(await buildClient(), {
				headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
			});
		}

		return new Response(Bun.file(`${import.meta.dir}/index.html`), {
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
		});
	},
} as Parameters<typeof serve>[0]);

console.log(`Huddle on http://localhost:${app.port} — open it in two tabs`);

if (process.env.NODE_ENV === "production") {
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`Received ${signal}; closing Huddle cleanly`);
		await app.stop(true);
		await server.close();
		process.exit(0);
	};
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
	process.once("SIGINT", () => void shutdown("SIGINT"));
}
