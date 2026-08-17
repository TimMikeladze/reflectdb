import { describe, expect, test } from "bun:test";
import { createArena, deflect, ensureBalls, isSane, resetBall, step } from "./physics.ts";
import {
	ARENA_R,
	BALL_R,
	BASE_SPEED,
	MIN_INWARD,
	RIM_BAND,
	STUCK_TICKS,
	TAU,
	TICK_MS,
	buildSectors,
	clampToSector,
	norm,
	sectorOf,
} from "./schema.ts";
import type { Ball, Player } from "./schema.ts";

const DT = TICK_MS / 1000;

function player(id: string, angle: number, joinedAt = 0): Player {
	return {
		id,
		gameId: "g",
		name: id,
		angle,
		score: 0,
		misses: 0,
		joinedAt,
		lastSeen: Date.now(),
	};
}

function ballAt(x: number, y: number, vx: number, vy: number): Ball {
	return { id: "b1", gameId: "g", x, y, vx, vy, speed: Math.hypot(vx, vy) };
}

/** Radial velocity component: positive means heading out of the arena. */
function outwardSpeed(b: Ball): number {
	const r = Math.hypot(b.x, b.y);
	if (r === 0) return 0;
	return (b.vx * b.x + b.vy * b.y) / r;
}

describe("deflect", () => {
	test("always sends the ball inward, from every angle and every hit offset", () => {
		// Spin can rotate a reflected velocity back out through the rim. If it
		// ever does, the ball re-collides next tick and looks stuck to the wall.
		for (let a = 0; a < TAU; a += TAU / 64) {
			for (let approach = -1.4; approach <= 1.4; approach += 0.2) {
				for (const offset of [-1, -0.75, -0.3, 0, 0.3, 0.75, 1]) {
					const rimR = ARENA_R - BALL_R + 0.005;
					// Incoming velocity: outward, tilted by `approach` from the normal.
					const dir = a + approach;
					const b = ballAt(
						Math.cos(a) * rimR,
						Math.sin(a) * rimR,
						Math.cos(dir) * BASE_SPEED,
						Math.sin(dir) * BASE_SPEED,
					);

					deflect(b, rimR, offset);

					expect(isSane(b)).toBe(true);
					// Heading back toward the centre, by a real margin.
					expect(outwardSpeed(b)).toBeLessThanOrEqual(-MIN_INWARD * b.speed * 0.999);
					// Parked inside the collision boundary.
					expect(Math.hypot(b.x, b.y)).toBeLessThan(ARENA_R - BALL_R);
					// Speed is preserved as the stated speed, not silently drained.
					expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(b.speed, 10);
				}
			}
		}
	});

	test("keeps the ball moving after a dead-on hit at max approach", () => {
		const rimR = ARENA_R - BALL_R + 0.001;
		const b = ballAt(rimR, 0, BASE_SPEED, 0);
		deflect(b, rimR, 0);
		expect(b.vx).toBeLessThan(0);
		expect(Math.hypot(b.vx, b.vy)).toBeGreaterThan(0);
	});
});

describe("step — a ball is never stuck", () => {
	test("a perfect defender cannot pin the ball against the rim", () => {
		// The adversarial case: one player owning the whole rim, whose paddle
		// teleports under the ball every single tick. Nothing ever gets past it,
		// so if deflection could trap a ball, this is where it happens.
		const a = createArena("g");
		a.players.set("p1", player("p1", 0));
		ensureBalls(a);

		const b = [...a.balls.values()][0]!;
		let deflections = 0;
		let ticksInBand = 0;
		let worstStreak = 0;
		let returnsToCentre = 0;

		for (let i = 0; i < 6_000; i++) {
			// Paddle follows the ball exactly.
			const sectors = buildSectors([...a.players.values()]);
			const theta = norm(Math.atan2(b.y, b.x));
			const sector = sectorOf(sectors, theta)!;
			a.players.get("p1")!.angle = clampToSector(sector, theta);

			const hits = step(a, DT);
			deflections += hits.reduce((n, h) => n + h.score, 0);

			expect(isSane(b)).toBe(true);
			const r = Math.hypot(b.x, b.y);
			expect(r).toBeLessThanOrEqual(ARENA_R);

			if (r > ARENA_R - RIM_BAND) {
				ticksInBand++;
				worstStreak = Math.max(worstStreak, ticksInBand);
			} else {
				ticksInBand = 0;
			}
			if (r < ARENA_R * 0.5) returnsToCentre++;
		}

		// It kept playing...
		expect(deflections).toBeGreaterThan(50);
		// ...and never loitered at the rim anywhere near the watchdog threshold,
		// which means the watchdog never had to fire.
		expect(worstStreak).toBeLessThan(STUCK_TICKS);
		// ...and genuinely crossed the arena, rather than skimming the edge.
		expect(returnsToCentre).toBeGreaterThan(100);
	});

	test("survives a crowd of random paddles without wedging", () => {
		const a = createArena("g");
		for (let i = 0; i < 24; i++) a.players.set(`p${i}`, player(`p${i}`, Math.random() * TAU, i));
		ensureBalls(a);

		for (let i = 0; i < 4_000; i++) {
			for (const p of a.players.values()) {
				// Jitter every paddle — approximates 24 humans flailing.
				p.angle = norm(p.angle + (Math.random() - 0.5) * 0.4);
			}
			step(a, DT);

			for (const b of a.balls.values()) {
				expect(isSane(b)).toBe(true);
				expect(Math.hypot(b.x, b.y)).toBeLessThanOrEqual(ARENA_R);
			}
		}

		for (const b of a.balls.values()) {
			expect(a.rimTicks.get(b.id) ?? 0).toBeLessThanOrEqual(STUCK_TICKS);
		}
	});

	test("the watchdog recovers a ball that loiters at the rim anyway", () => {
		const a = createArena("g");
		a.players.set("p1", player("p1", Math.PI));
		const b = ballAt(ARENA_R - RIM_BAND * 0.5, 0, 0, BASE_SPEED); // skimming, no collision
		a.balls.set(b.id, b);
		a.rimTicks.set(b.id, STUCK_TICKS); // as if it had been there for two seconds

		step(a, DT);

		expect(b.x).toBe(0);
		expect(b.y).toBe(0);
		expect(b.speed).toBe(BASE_SPEED);
		expect(a.rimTicks.has(b.id)).toBe(false);
	});

	test("recovers a ball with NaN coordinates", () => {
		const a = createArena("g");
		a.players.set("p1", player("p1", 0));
		const b = ballAt(Number.NaN, 0, 0.1, 0.1);
		a.balls.set(b.id, b);

		step(a, DT);

		expect(isSane(b)).toBe(true);
		expect(Math.hypot(b.x, b.y)).toBeLessThan(ARENA_R);
	});

	test("recovers a ball that lost its velocity", () => {
		const a = createArena("g");
		a.players.set("p1", player("p1", 0));
		const b = ballAt(0.2, 0.2, 0, 0);
		a.balls.set(b.id, b);

		step(a, DT);

		expect(isSane(b)).toBe(true);
		expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(BASE_SPEED, 10);
	});

	test("an empty rim parks the ball instead of losing it", () => {
		// No players: whichever sector the ball reaches has no owner.
		const a = createArena("g");
		const b = ballAt(0.9, 0, 3, 0);
		a.balls.set(b.id, b);

		step(a, DT);

		expect(isSane(b)).toBe(true);
		expect(Math.hypot(b.x, b.y)).toBeLessThan(ARENA_R);
	});
});

describe("resetBall", () => {
	test("always produces a moving ball at the centre", () => {
		for (let i = 0; i < 200; i++) {
			const b = ballAt(0.9, 0.9, 0, 0);
			resetBall(b);
			expect(isSane(b)).toBe(true);
			expect(Math.hypot(b.x, b.y)).toBe(0);
			expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(BASE_SPEED, 10);
		}
	});
});
