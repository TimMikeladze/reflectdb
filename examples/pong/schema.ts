/**
 * Infinite-player pong — shared schema and arena math.
 *
 * Both sides import this file: the server uses the geometry to decide whether a
 * ball was deflected or missed, the client uses the identical functions to draw
 * paddles and to clamp the local player's input. One definition, no drift.
 */

import { defineSyncQueries, presence, t, view } from "../../src/core/index.ts";

// ── Arena constants ─────────────────────────────────────────────────────
// The arena is a unit circle. Everything below is in that space; the client
// scales it to pixels at render time.

export const TAU = Math.PI * 2;
export const ARENA_R = 1;
export const BALL_R = 0.028;

/** Share of a player's sector covered by their paddle. The rest is the gap. */
export const PADDLE_FILL = 0.55;
export const MIN_PADDLE_RAD = 0.09;
export const MAX_PADDLE_RAD = TAU * 0.45;

export const BASE_SPEED = 0.6; // arena units per second
export const MAX_SPEED = 2.6;
export const SPEED_GAIN = 1.035; // per deflection
export const SPIN = 0.55; // how much an off-centre hit curves the ball

/**
 * Minimum share of a deflected ball's speed that must point back toward the
 * centre. Spin alone could rotate a grazing hit until it points along (or back
 * out through) the rim, and the ball would then re-collide every tick instead of
 * leaving — a ball that looks stuck to the wall. 0.3 leaves the ball at least
 * ~17° off the tangent.
 */
export const MIN_INWARD = 0.3;

/** How far inside the rim a deflected ball is parked. */
export const RIM_INSET = 0.01;

/**
 * Watchdog: a ball loitering within this band of the rim for this many ticks is
 * put back in the centre, whatever the physics thinks. The rules above should
 * make it unreachable; this is what makes "never stuck" true rather than likely.
 */
export const RIM_BAND = BALL_R * 3;
export const STUCK_TICKS = 60; // ~2s at TICK_MS

/** Physics tick. Also the broadcast rate for ball positions. */
export const TICK_MS = 25;

/** How often a client ships its paddle angle. One op, ~40 bytes. */
export const PADDLE_SEND_MS = 16;
/** Don't send a move smaller than this (radians) — it isn't visible. */
export const PADDLE_EPSILON = 0.0015;

/**
 * Rate at which a remote paddle eases toward its last known angle, per second.
 * Paddle updates arrive at whatever rate the network delivers them; drawing them
 * raw makes other players teleport between samples. Easing at ~22/s converges in
 * about 100 ms, which reads as motion rather than lag.
 *
 * Your own paddle is never eased — it renders from local input.
 */
export const PADDLE_SMOOTHING = 22;

/** A player that hasn't written anything in this long is dropped from the arena. */
export const IDLE_TIMEOUT_MS = 15_000;
/** Client keepalive — comfortably inside IDLE_TIMEOUT_MS. */
export const KEEPALIVE_MS = 4_000;

export const PLAYERS_PER_BALL = 5;
export const MAX_BALLS = 12;

export const MAX_NAME_LEN = 14;

// ── Row types ───────────────────────────────────────────────────────────

export type Player = {
	id: string;
	gameId: string;
	name: string;
	/** Paddle centre, absolute radians in [0, TAU). */
	angle: number;
	score: number;
	misses: number;
	joinedAt: number;
	lastSeen: number;
};

export type Ball = {
	id: string;
	gameId: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	speed: number;
};

export type Standing = {
	id: string;
	name: string;
	score: number;
	misses: number;
	rank: number;
};

export interface AppAuth extends Record<string, unknown> {
	userId: string;
}

// ── Schema ──────────────────────────────────────────────────────────────

export const queries = defineSyncQueries({
	/**
	 * Every paddle in the arena. Clients write one field — `angle` — on their
	 * own row, at pointer rate.
	 *
	 * `serverSet` stamps `gameId` from the subscription params rather than
	 * trusting the payload, and refreshes `lastSeen` on every write (which makes
	 * each paddle move double as a heartbeat). `readonly` keeps the client out of
	 * the score columns on update; `mutate` re-derives them on insert, because
	 * readonly fields are only stripped from updates.
	 *
	 * `groupBy` collapses every subscriber in a game into ONE query execution per
	 * broadcast — without it, per-user auth means N executions for N players,
	 * which is the whole ballgame when N is meant to be unbounded.
	 */
	players: {
		row: t<Player>(),
		params: t<{ gameId: string }>(),
		conflict: "lww",
		readonly: ["score", "misses", "joinedAt"],
		serverSet: ["gameId", "lastSeen"],
	},

	/**
	 * Ball state, owned entirely by the server's physics loop. Declared as a
	 * regular query rather than a `view()` for one reason: views take no options,
	 * and this table needs `groupBy`. It rejects client writes from `mutate`
	 * instead.
	 */
	balls: {
		row: t<Ball>(),
		params: t<{ gameId: string }>(),
		conflict: "lww",
	},

	/**
	 * Leaderboard. A `view()` is the right shape here — read-only by
	 * construction, recomputed whenever `players` changes, and low-frequency
	 * enough that running once per subscriber costs nothing.
	 */
	standings: view({
		row: t<Standing>(),
		params: t<{ gameId: string }>(),
		deps: ["players"],
	}),

	/** Emoji taunts. Ephemeral: never persisted, expires on its own. */
	taunts: presence({
		state: t<{ emoji: string; at: number }>(),
		params: t<{ gameId: string }>(),
		ttlMs: 2_000,
	}),
});

// ── Angle helpers ───────────────────────────────────────────────────────

export function norm(angle: number): number {
	const a = angle % TAU;
	return a < 0 ? a + TAU : a;
}

/** Shortest signed distance from `b` to `a`, in [-PI, PI]. */
export function angleDiff(a: number, b: number): number {
	let d = norm(a) - norm(b);
	if (d > Math.PI) d -= TAU;
	if (d < -Math.PI) d += TAU;
	return d;
}

export function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

// ── Sectors ─────────────────────────────────────────────────────────────

export interface Sector {
	id: string;
	index: number;
	/** Sector bounds, absolute radians. `end` is always `start + width`. */
	start: number;
	end: number;
	width: number;
	/** Half the paddle's angular width. */
	half: number;
}

/** Deterministic seating order — the same on every client and on the server. */
export function orderPlayers<T extends { id: string; joinedAt: number }>(list: T[]): T[] {
	return [...list].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
}

/**
 * Carve the rim into one sector per player. N players means N equal arcs, so
 * the arena re-partitions the moment somebody joins or drops.
 */
export function buildSectors(list: Array<{ id: string; joinedAt: number }>): Sector[] {
	const ordered = orderPlayers(list);
	const n = ordered.length;
	if (n === 0) return [];

	const width = TAU / n;
	const paddle = Math.min(
		Math.max(width * PADDLE_FILL, MIN_PADDLE_RAD),
		MAX_PADDLE_RAD,
		width * 0.92, // always leave a gap to shoot through
	);

	return ordered.map((p, index) => ({
		id: p.id,
		index,
		start: index * width,
		end: index * width + width,
		width,
		half: paddle / 2,
	}));
}

export function sectorOf(sectors: Sector[], angle: number): Sector | undefined {
	if (sectors.length === 0) return undefined;
	const width = sectors[0]!.width;
	const index = Math.min(sectors.length - 1, Math.floor(norm(angle) / width));
	return sectors[index];
}

/**
 * Pin a requested paddle angle inside its own sector. A pointer outside the
 * sector snaps to whichever edge is actually nearer, so dragging past your slice
 * never flips the paddle to the far side.
 */
export function clampToSector(sector: Sector, angle: number): number {
	const rel = norm(angle - sector.start);
	const lo = sector.half;
	const hi = sector.width - sector.half;
	if (rel >= lo && rel <= hi) return norm(sector.start + rel);
	if (rel < lo) return norm(sector.start + lo);
	// Past the far edge: is the wrap-around edge closer?
	return norm(sector.start + (rel - hi < TAU - rel + lo ? hi : lo));
}

// ── Cosmetics (shared so both sides agree on a player's colour) ─────────

export function colorFor(id: string): string {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
	return `hsl(${h} 90% 62%)`;
}
