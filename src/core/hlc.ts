import { MAX_CLOCK_DRIFT_MS } from "./types.ts";

export interface HLC {
	ms: number;
	counter: number;
	nodeId: string;
}

const MS_PAD = 19;
const COUNTER_PAD = 4;
const COUNTER_MAX = 9999; // 10**COUNTER_PAD - 1; overflow rolls ms forward

export function createHlc(nodeId: string): HLC {
	return { ms: 0, counter: 0, nodeId };
}

/**
 * Roll the clock forward by one ms if the counter would overflow COUNTER_PAD,
 * so the padded string ordering stays correct even under batched inserts that
 * stamp >9999 ops in the same wall-clock millisecond.
 */
function normalize(ms: number, counter: number, nodeId: string): HLC {
	if (counter > COUNTER_MAX) {
		return { ms: ms + 1, counter: 0, nodeId };
	}
	return { ms, counter, nodeId };
}

export function sendHlc(local: HLC): HLC {
	const wall = Date.now();
	const ms = Math.max(wall, local.ms);
	const counter = ms === local.ms ? local.counter + 1 : 0;
	return normalize(ms, counter, local.nodeId);
}

export function receiveHlc(local: HLC, remote: HLC): HLC {
	const wall = Date.now();

	const clampedRemoteMs = Math.min(remote.ms, wall + MAX_CLOCK_DRIFT_MS);

	const ms = Math.max(wall, local.ms, clampedRemoteMs);
	const counter =
		ms === local.ms && ms === clampedRemoteMs
			? Math.max(local.counter, remote.counter) + 1
			: ms === local.ms
				? local.counter + 1
				: ms === clampedRemoteMs
					? remote.counter + 1
					: 0;
	return normalize(ms, counter, local.nodeId);
}

export function packHlc(hlc: HLC): string {
	const ms = String(hlc.ms).padStart(MS_PAD, "0");
	const counter = String(hlc.counter).padStart(COUNTER_PAD, "0");
	return `${ms}.${counter}.${hlc.nodeId}`;
}

export function unpackHlc(packed: string): HLC {
	const firstDot = packed.indexOf(".");
	const secondDot = firstDot < 0 ? -1 : packed.indexOf(".", firstDot + 1);
	if (firstDot < 0 || secondDot < 0) {
		throw new Error(`Malformed HLC: ${packed}`);
	}
	const ms = Number(packed.slice(0, firstDot));
	const counter = Number(packed.slice(firstDot + 1, secondDot));
	const nodeId = packed.slice(secondDot + 1);
	if (!Number.isFinite(ms) || !Number.isFinite(counter) || nodeId.length === 0) {
		throw new Error(`Malformed HLC: ${packed}`);
	}
	return { ms, counter, nodeId };
}

export function compareHlc(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
