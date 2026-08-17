/**
 * Render-side smoothing for remote paddles.
 *
 * Paddle updates arrive at network rate and at irregular intervals. Drawing them
 * as they land makes other players teleport between samples — the give-away that
 * you are watching a network feed rather than a game. Easing toward the last
 * known angle every frame turns whatever arrives into continuous motion.
 *
 * Kept DOM-free so it can be tested directly.
 */

import { PADDLE_SMOOTHING, angleDiff, norm } from "./schema.ts";

export interface PaddleLike {
	id: string;
	angle: number;
}

/**
 * Advance each paddle's render angle toward its authoritative angle.
 *
 * @param selfId  the local player, who is never eased — their paddle renders
 *                straight from pointer input and has no latency to hide.
 * @param dt      seconds since the last frame.
 */
export function advancePaddles(
	players: PaddleLike[],
	smooth: Map<string, number>,
	selfId: string,
	selfAngle: number,
	dt: number,
): void {
	// Frame-rate independent: the same fraction of the remaining gap closes per
	// second no matter how often this runs.
	const k = 1 - Math.exp(-PADDLE_SMOOTHING * dt);
	const seen = new Set<string>();

	for (const p of players) {
		seen.add(p.id);
		if (p.id === selfId) {
			smooth.set(p.id, selfAngle);
			continue;
		}
		const current = smooth.get(p.id);
		// A paddle we have never drawn starts where it is, not at zero — a new
		// player should appear in place, not sweep in from 3 o'clock.
		smooth.set(
			p.id,
			current === undefined ? p.angle : norm(current + angleDiff(p.angle, current) * k),
		);
	}

	// Forget players who left, so a rejoin doesn't inherit a stale angle.
	for (const id of [...smooth.keys()]) {
		if (!seen.has(id)) smooth.delete(id);
	}
}
