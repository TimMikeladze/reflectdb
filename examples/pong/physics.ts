/**
 * Ball physics and arena bookkeeping.
 *
 * Split out from the server so it can be exercised without a socket — see
 * `physics.test.ts`, which is mostly one property: a ball is never stuck.
 */

import {
	ARENA_R,
	BALL_R,
	BASE_SPEED,
	IDLE_TIMEOUT_MS,
	MAX_BALLS,
	MAX_SPEED,
	MIN_INWARD,
	PLAYERS_PER_BALL,
	RIM_BAND,
	RIM_INSET,
	SPEED_GAIN,
	SPIN,
	STUCK_TICKS,
	TAU,
	angleDiff,
	buildSectors,
	clampToSector,
	norm,
	sectorOf,
} from "./schema.ts";
import type { Ball, Player } from "./schema.ts";

export interface Arena {
	id: string;
	players: Map<string, Player>;
	balls: Map<string, Ball>;
	/** Consecutive ticks each ball has spent hugging the rim — see the watchdog. */
	rimTicks: Map<string, number>;
	lastTick: number;
	ballSeq: number;
}

export interface Hit {
	id: string;
	score: number;
	misses: number;
}

export function createArena(id: string, now = Date.now()): Arena {
	return {
		id,
		players: new Map(),
		balls: new Map(),
		rimTicks: new Map(),
		lastTick: now,
		ballSeq: 0,
	};
}

// ── Balls ───────────────────────────────────────────────────────────────

export function spawnBall(id: string, gameId: string): Ball {
	const ball: Ball = { id, gameId, x: 0, y: 0, vx: 0, vy: 0, speed: BASE_SPEED };
	resetBall(ball);
	return ball;
}

/** Back to the centre, fresh direction, base speed. */
export function resetBall(b: Ball): void {
	const dir = Math.random() * TAU;
	b.x = 0;
	b.y = 0;
	b.speed = BASE_SPEED;
	b.vx = Math.cos(dir) * BASE_SPEED;
	b.vy = Math.sin(dir) * BASE_SPEED;
}

/** More players, more balls. */
export function ensureBalls(a: Arena): void {
	const target = Math.max(
		1,
		Math.min(MAX_BALLS, 1 + Math.floor(a.players.size / PLAYERS_PER_BALL)),
	);
	while (a.balls.size < target) {
		const id = `ball-${++a.ballSeq}`;
		a.balls.set(id, spawnBall(id, a.id));
	}
	while (a.balls.size > target) {
		const oldest = a.balls.keys().next().value as string | undefined;
		if (!oldest) break;
		a.balls.delete(oldest);
		a.rimTicks.delete(oldest);
	}
}

/**
 * Reflect off the rim, add spin from where on the paddle it landed, speed up.
 *
 * The direction is rebuilt in the rim's own frame (inward normal + tangent)
 * rather than reflected in place, because that makes the one invariant that
 * matters cheap to enforce: a deflected ball ALWAYS leaves the rim. Reflecting
 * and then rotating for spin can hand back an outward-pointing velocity, and a
 * ball that leaves a collision still heading outward re-collides on the next
 * tick, for as long as the paddle stays under it — a ball stuck to the wall.
 *
 * @param offset where on the paddle it hit, -1 (one edge) to 1 (the other).
 */
export function deflect(b: Ball, r: number, offset: number): void {
	const nx = b.x / r;
	const ny = b.y / r;
	// Tangent, counter-clockwise.
	const tx = -ny;
	const ty = nx;

	const speed = Math.min(b.speed * SPEED_GAIN, MAX_SPEED);
	b.speed = speed;

	// Angles are measured from the INWARD normal, so `dr` below is directly
	// "how much of the speed goes toward the centre".
	const inward = Math.abs(b.vx * nx + b.vy * ny);
	const tangential = b.vx * tx + b.vy * ty;

	const spun = Math.atan2(tangential, inward) + offset * SPIN;
	let dr = Math.cos(spun);
	let dt = Math.sin(spun);

	// Floor the inward component. These are unit-vector coordinates, so the
	// tangential part is whatever is left over — direction preserved, sign kept.
	if (dr < MIN_INWARD) {
		dr = MIN_INWARD;
		dt = Math.sign(dt || 1) * Math.sqrt(1 - MIN_INWARD * MIN_INWARD);
	}

	b.vx = (-dr * nx + dt * tx) * speed;
	b.vy = (-dr * ny + dt * ty) * speed;

	// Park it inside the rim so the next tick starts clear of the boundary.
	const inset = ARENA_R - BALL_R - RIM_INSET;
	b.x = nx * inset;
	b.y = ny * inset;
}

/** A ball that fails this can never satisfy any condition in `step`. */
export function isSane(b: Ball): boolean {
	return (
		Number.isFinite(b.x) &&
		Number.isFinite(b.y) &&
		Number.isFinite(b.vx) &&
		Number.isFinite(b.vy) &&
		b.speed > 0 &&
		b.vx * b.vx + b.vy * b.vy > 0
	);
}

/** Put a ball back in play and forget whatever it was doing. */
function recover(a: Arena, b: Ball): void {
	resetBall(b);
	a.rimTicks.delete(b.id);
}

/** Advance every ball by `dt` seconds. Returns per-player score deltas. */
export function step(a: Arena, dt: number): Hit[] {
	const sectors = buildSectors([...a.players.values()]);
	const hits: Hit[] = [];

	for (const b of a.balls.values()) {
		if (!isSane(b)) {
			recover(a, b);
			continue;
		}

		b.x += b.vx * dt;
		b.y += b.vy * dt;

		const r = Math.hypot(b.x, b.y);
		if (r >= ARENA_R - BALL_R) {
			const theta = norm(Math.atan2(b.y, b.x));
			const sector = sectorOf(sectors, theta);
			const owner = sector ? a.players.get(sector.id) : undefined;

			if (!sector || !owner) {
				recover(a, b);
				continue;
			}

			// The client clamps its own paddle, but the server clamps again —
			// a client is free to lie about `angle`, and this is the only place
			// that knows the current seating chart.
			const centre = clampToSector(sector, owner.angle);
			const reach = sector.half + BALL_R;
			const offset = angleDiff(theta, centre);

			if (Math.abs(offset) <= reach) {
				deflect(b, r, offset / reach);
				hits.push({ id: owner.id, score: 1, misses: 0 });
			} else {
				hits.push({ id: owner.id, score: 0, misses: 1 });
				recover(a, b);
				continue;
			}
		}

		// Watchdog. `deflect` guarantees a ball leaves the rim, so loitering in
		// the outer band for seconds means something upstream is wrong — a paddle
		// pinning it, a float edge case, a tick storm. Rather than trust the
		// physics to be exhaustive, put the ball back in play.
		if (Math.hypot(b.x, b.y) > ARENA_R - RIM_BAND) {
			const ticks = (a.rimTicks.get(b.id) ?? 0) + 1;
			if (ticks > STUCK_TICKS) {
				recover(a, b);
			} else {
				a.rimTicks.set(b.id, ticks);
			}
		} else {
			a.rimTicks.delete(b.id);
		}
	}

	return hits;
}

/** Drop players who have gone quiet. Returns how many left. */
export function reap(a: Arena, now: number): number {
	let dropped = 0;
	for (const [id, p] of a.players) {
		if (now - p.lastSeen > IDLE_TIMEOUT_MS) {
			a.players.delete(id);
			dropped++;
		}
	}
	return dropped;
}
