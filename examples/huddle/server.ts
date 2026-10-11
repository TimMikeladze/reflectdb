/**
 * Huddle — sticky notes, live cursors, live ink and reactions, with the
 * high-rate traffic going peer-to-peer over WebRTC. See README.md.
 *
 * The server is an ordinary reflectdb sync server. It sees only a throttled
 * trickle of cursor and ink frames, no reactions at all, and the finished
 * notes and strokes; what it also carries is the WebRTC signaling (offers,
 * answers, ICE candidates) as `signal` messages.
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
	MAX_STROKES_PER_ROOM,
	ROOM_IDLE_MS,
	STROKE_TTL_MS,
	applyNoteWrite,
	applyStrokeWrite,
	isNoteId,
	isRoomId,
	queries,
} from "./schema.ts";
import type { Note, Stroke } from "./schema.ts";

/**
 * roomId → row id → row, per table. Everything is in memory; an idle Machine
 * stops and takes it along.
 */
type Db = { notes: Map<string, Map<string, Note>>; strokes: Map<string, Map<string, Stroke>> };
const db: Db = { notes: new Map(), strokes: new Map() };
/** Last read or write per room, for idle eviction. */
const lastActive = new Map<string, number>();

const { transport, websocket } = createBunWsServerTransport({
	maxMessageBytes: 64_000,
	pingIntervalMs: 30_000,
});

const server = createSyncServer<typeof queries, Db>({
	queries,
	db,
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

// Ephemeral headroom: alone in a room (or with nobody direct yet) every cursor,
// ink and ping frame goes through the server at full rate, which is more than
// the default 60/s.
server.rateLimit({ opsPerSecond: 40, opsPerMinute: 1_200, ephemeralPerSecond: 200 });

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

/** Rooms with anything in them, across both tables: what MAX_ROOMS bounds. */
function roomCount(): number {
	return new Set([...db.notes.keys(), ...db.strokes.keys()]).size;
}

/** The room's map in `table`, created on first write if the server has room for it. */
function roomFor<T>(table: Map<string, Map<string, T>>, roomId: string): Map<string, T> {
	let room = table.get(roomId);
	if (!room) {
		if (!db.notes.has(roomId) && !db.strokes.has(roomId) && roomCount() >= MAX_ROOMS) {
			throw new MutationError("mutation_rejected", "the demo is full");
		}
		room = new Map();
		table.set(roomId, room);
	}
	return room;
}

server.implement("notes", {
	room: "huddle/:roomId",
	query: (ctx, db) => {
		if (db.notes.has(ctx.params.roomId)) lastActive.set(ctx.params.roomId, Date.now());
		return [...(db.notes.get(ctx.params.roomId)?.values() ?? [])];
	},
	mutate: async (op, ctx, db) => {
		const roomId = ctx.params.roomId;
		// Checked before anything is stored: the id becomes a Map key.
		if (!isNoteId(op.rowId)) throw new MutationError("mutation_rejected", "invalid note id");
		lastActive.set(roomId, Date.now());
		if (op.type === "delete") {
			db.notes.get(roomId)?.delete(op.rowId);
			return;
		}
		const room = roomFor(db.notes, roomId);
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

server.implement("strokes", {
	room: "huddle/:roomId",
	query: (ctx, db) => [...(db.strokes.get(ctx.params.roomId)?.values() ?? [])],
	serverSet: { createdAt: () => Date.now() },
	mutate: async (op, ctx, db) => {
		const roomId = ctx.params.roomId;
		if (!isNoteId(op.rowId)) throw new MutationError("mutation_rejected", "invalid stroke id");
		lastActive.set(roomId, Date.now());
		if (op.type === "delete") {
			db.strokes.get(roomId)?.delete(op.rowId);
			return;
		}
		const room = roomFor(db.strokes, roomId);
		const stroke = applyStrokeWrite(
			room.get(op.rowId),
			op.rowId,
			roomId,
			(op.payload ?? {}) as Partial<Stroke>,
			Date.now(),
		);
		if (typeof stroke === "string") throw new MutationError("mutation_rejected", stroke);
		room.set(op.rowId, stroke);
		// Full: the oldest stroke goes, after this write has committed.
		if (room.size > MAX_STROKES_PER_ROOM) {
			const oldest = room.keys().next().value;
			if (oldest !== undefined) setTimeout(() => void deleteRow("strokes", roomId, oldest), 0);
		}
	},
});

/**
 * Delete through applyServerOp, never straight from the Map: that is what
 * stamps a clock, logs the op and tells every open tab, so nobody keeps a row
 * the server no longer has.
 */
async function deleteRow(table: "notes" | "strokes", roomId: string, id: string): Promise<void> {
	const rows = db[table].get(roomId);
	if (!rows?.has(id)) return;
	await server.applyServerOp(
		{ type: "delete", table, rowId: id, payload: null },
		async () => {
			rows.delete(id);
		},
		{ roomKey: `huddle/${roomId}` },
	);
}

// ── Expiry ─────────────────────────────────────────────────────────────

/**
 * Clear rooms nobody has touched for ROOM_IDLE_MS, and ink older than
 * STROKE_TTL_MS. Guest tokens are free to mint, so without the first one
 * visitor could fill MAX_ROOMS and lock everyone out until the Machine restarts.
 */
async function expire(): Promise<void> {
	const now = Date.now();
	for (const [roomId, strokes] of db.strokes) {
		for (const [id, stroke] of strokes) {
			if (stroke.createdAt < now - STROKE_TTL_MS) await deleteRow("strokes", roomId, id);
		}
	}
	const cutoff = now - ROOM_IDLE_MS;
	for (const roomId of new Set([...db.notes.keys(), ...db.strokes.keys()])) {
		if ((lastActive.get(roomId) ?? 0) >= cutoff) continue;
		for (const id of Array.from(db.notes.get(roomId)?.keys() ?? []))
			await deleteRow("notes", roomId, id);
		for (const id of Array.from(db.strokes.get(roomId)?.keys() ?? []))
			await deleteRow("strokes", roomId, id);
		db.notes.delete(roomId);
		db.strokes.delete(roomId);
		lastActive.delete(roomId);
	}
	for (const table of [db.notes, db.strokes] as Map<string, Map<string, unknown>>[]) {
		for (const [roomId, rows] of table) if (rows.size === 0) table.delete(roomId);
	}
}

server.interval(60_000, () => {
	expire().catch((err) => console.error("[huddle] expiry failed:", err));
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
