/** Server-authoritative Tetris rules, kept DOM-free for direct testing. */

import {
	BOARD_HEIGHT,
	BOARD_WIDTH,
	IDLE_TIMEOUT_MS,
	PIECE_KINDS,
	pieceCells,
	pieceValue,
} from "./schema.ts";
import type { InputAction, PieceKind, Player } from "./schema.ts";

/**
 * Sub-second tick state, held beside the player rather than in it.
 *
 * Gravity has to accumulate across ticks that are individually far shorter
 * than one fall interval — 50 ms ticks against an 800 ms interval at level 1.
 * Keeping the accumulator on the row would mean a database write per player
 * per tick just to carry 50 ms forward, and reading the row back each tick
 * without writing it simply threw the accumulation away: the piece then never
 * fell on its own at all.
 */
export interface PlayerClock {
	fallElapsedMs: number;
	aliveElapsedMs: number;
}

export function createClock(): PlayerClock {
	return { fallElapsedMs: 0, aliveElapsedMs: 0 };
}

/** Points per second survived, multiplied by the level the run has reached. */
export const SURVIVAL_POINTS_PER_SECOND = 1;

export interface SequencedInput {
	seq: number;
	action: InputAction;
}

const ADJECTIVES = [
	"brisk",
	"cosmic",
	"dizzy",
	"electric",
	"fuzzy",
	"lucky",
	"neon",
	"quiet",
	"rapid",
	"tiny",
] as const;
const NOUNS = [
	"badger",
	"comet",
	"gecko",
	"mango",
	"otter",
	"panda",
	"pixel",
	"robot",
	"tiger",
	"waffle",
] as const;

export function emptyBoard(): number[] {
	return Array.from({ length: BOARD_WIDTH * BOARD_HEIGHT }, () => 0);
}

export function randomName(taken: Iterable<string>, random = Math.random): string {
	const used = new Set(taken);
	for (let attempt = 0; attempt < 32; attempt++) {
		const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)]!;
		const noun = NOUNS[Math.floor(random() * NOUNS.length)]!;
		const suffix = Math.floor(random() * 100)
			.toString()
			.padStart(2, "0");
		const name = `${adjective}-${noun}-${suffix}`;
		if (!used.has(name)) return name;
	}
	let fallback = Math.floor(random() * 1_000_000);
	while (used.has(`player-${fallback.toString().padStart(6, "0")}`)) fallback++;
	return `player-${fallback.toString().padStart(6, "0")}`;
}

function refillBag(random: () => number): PieceKind[] {
	const bag = [...PIECE_KINDS];
	for (let i = bag.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[bag[i], bag[j]] = [bag[j]!, bag[i]!];
	}
	return bag;
}

const PREDICTION_QUEUE_SIZE = PIECE_KINDS.length * 3;

function takePiece(player: Pick<Player, "bag">, random: () => number): PieceKind {
	// Buffer several complete bags. Even a burst of hard drops can then be
	// predicted exactly without the client inventing any random pieces.
	while (player.bag.length < PREDICTION_QUEUE_SIZE) player.bag.push(...refillBag(random));
	return player.bag.shift()!;
}

function spawnX(kind: PieceKind): number {
	const width = Math.max(...pieceCells(kind, 0).map((cell) => cell.x)) + 1;
	return Math.floor((BOARD_WIDTH - width) / 2);
}

export function createPlayer(
	id: string,
	name: string,
	now = Date.now(),
	random = Math.random,
): Player {
	const player: Player = {
		id,
		name,
		board: emptyBoard(),
		piece: "I",
		next: "O",
		rotation: 0,
		x: 0,
		y: 0,
		score: 0,
		lines: 0,
		deaths: 0,
		action: "join",
		inputSeq: 0,
		processedSeq: 0,
		joinedAt: now,
		lastSeen: now,
		bag: [],
	};
	player.piece = takePiece(player, random);
	player.next = takePiece(player, random);
	player.x = spawnX(player.piece);
	return player;
}

export function publicPlayer(player: Player): Player {
	return { ...player, board: [...player.board], bag: [...player.bag] };
}

/** Rebuild the immediate client view from a server snapshot plus unacked keys. */
export function replayInputs(authoritative: Player, inputs: readonly SequencedInput[]): Player {
	const predicted: Player = {
		...authoritative,
		board: [...authoritative.board],
		bag: [...authoritative.bag],
	};
	for (const input of inputs) {
		if (input.seq <= authoritative.processedSeq) continue;
		predicted.inputSeq = input.seq;
		predicted.action = input.action;
		applyInput(predicted, input.action);
	}
	return predicted;
}

export function canPlace(
	player: Pick<Player, "board">,
	kind: PieceKind,
	rotation: number,
	x: number,
	y: number,
): boolean {
	for (const cell of pieceCells(kind, rotation, x, y)) {
		if (cell.x < 0 || cell.x >= BOARD_WIDTH || cell.y >= BOARD_HEIGHT) return false;
		if (cell.y >= 0 && player.board[cell.y * BOARD_WIDTH + cell.x] !== 0) return false;
	}
	return true;
}

export function landingY(player: Player): number {
	let y = player.y;
	while (canPlace(player, player.piece, player.rotation, player.x, y + 1)) y++;
	return y;
}

function clearLines(player: Player): number {
	const rows: number[][] = [];
	let cleared = 0;
	for (let y = 0; y < BOARD_HEIGHT; y++) {
		const row = player.board.slice(y * BOARD_WIDTH, (y + 1) * BOARD_WIDTH);
		if (row.every((cell) => cell !== 0)) cleared++;
		else rows.push(row);
	}
	while (rows.length < BOARD_HEIGHT) rows.unshift(Array.from({ length: BOARD_WIDTH }, () => 0));
	player.board = rows.flat();
	return cleared;
}

function resetAfterDeath(player: Player, random: () => number): void {
	player.board = emptyBoard();
	player.score = 0;
	player.lines = 0;
	player.deaths++;
	// Continue the already-generated queue so a predicted top-out stays exact.
	player.piece = takePiece(player, random);
	player.next = takePiece(player, random);
	player.rotation = 0;
	player.x = spawnX(player.piece);
	player.y = 0;
}

/** Spawn the queued piece; a blocked spawn is a death and immediate fresh run. */
export function spawnNext(player: Player, random = Math.random): boolean {
	player.piece = player.next;
	player.next = takePiece(player, random);
	player.rotation = 0;
	player.x = spawnX(player.piece);
	player.y = 0;
	if (canPlace(player, player.piece, player.rotation, player.x, player.y)) return false;
	resetAfterDeath(player, random);
	return true;
}

/** Settle the active piece, clear rows, score them, and continue with the queue. */
export function lockPiece(player: Player, random = Math.random): boolean {
	const value = pieceValue(player.piece);
	for (const cell of pieceCells(player.piece, player.rotation, player.x, player.y)) {
		if (cell.y >= 0) player.board[cell.y * BOARD_WIDTH + cell.x] = value;
	}
	const cleared = clearLines(player);
	const points = [0, 100, 300, 500, 800][cleared] ?? cleared * 300;
	player.lines += cleared;
	player.score += points;
	return spawnNext(player, random);
}

function move(player: Player, dx: number, dy: number): boolean {
	if (!canPlace(player, player.piece, player.rotation, player.x + dx, player.y + dy)) {
		return false;
	}
	player.x += dx;
	player.y += dy;
	return true;
}

function rotate(player: Player, direction: 1 | -1): boolean {
	const nextRotation = (player.rotation + direction + 4) % 4;
	for (const kick of [0, -1, 1, -2, 2]) {
		if (canPlace(player, player.piece, nextRotation, player.x + kick, player.y)) {
			player.rotation = nextRotation;
			player.x += kick;
			return true;
		}
	}
	return false;
}

/** Apply one validated user command. Returns whether visible game state changed. */
export function applyInput(player: Player, action: InputAction, random = Math.random): boolean {
	switch (action) {
		case "left":
			return move(player, -1, 0);
		case "right":
			return move(player, 1, 0);
		case "rotate-cw":
			return rotate(player, 1);
		case "rotate-ccw":
			return rotate(player, -1);
		case "soft-drop":
			// Dropping is a placement control, not a way to farm points: the
			// score comes from time survived and lines cleared, so hammering
			// the drop key only gets you to the next piece sooner.
			if (move(player, 0, 1)) return true;
			lockPiece(player, random);
			return true;
		case "hard-drop":
			player.y = landingY(player);
			lockPiece(player, random);
			return true;
		case "join":
		case "heartbeat":
			return false;
	}
}

export const LINES_PER_LEVEL = 5;

export function levelFor(lines: number): number {
	return Math.floor(Math.max(0, lines) / LINES_PER_LEVEL) + 1;
}

/** Each player's own line count drives an increasingly fast gravity curve. */
export function gravityMs(lines: number): number {
	const level = levelFor(lines);
	return Math.max(75, Math.round(800 * 0.82 ** (level - 1)));
}

/**
 * Advance one player by `elapsedMs` of wall clock: pay out survival points and
 * step gravity. Large pauses are capped so a stalled process cannot cause a
 * gravity storm, and `clock` carries the remainder that is shorter than a
 * second or a fall interval into the next tick.
 */
export function advancePlayer(
	player: Player,
	clock: PlayerClock,
	elapsedMs: number,
	random = Math.random,
): boolean {
	const elapsed = Math.min(Math.max(elapsedMs, 0), 1_000);
	let changed = false;

	// Surviving is the score. A long clean run at a high level outpays a burst
	// of fast drops, and a top-out costs every point it earned.
	clock.aliveElapsedMs += elapsed;
	while (clock.aliveElapsedMs >= 1_000) {
		clock.aliveElapsedMs -= 1_000;
		player.score += SURVIVAL_POINTS_PER_SECOND * levelFor(player.lines);
		changed = true;
	}

	clock.fallElapsedMs += elapsed;
	let steps = 0;
	while (clock.fallElapsedMs >= gravityMs(player.lines) && steps++ < 12) {
		clock.fallElapsedMs -= gravityMs(player.lines);
		if (!move(player, 0, 1)) lockPiece(player, random);
		changed = true;
	}

	return changed;
}

export function reap(players: Map<string, Player>, now: number): number {
	let removed = 0;
	for (const [id, player] of players) {
		if (now - player.lastSeen > IDLE_TIMEOUT_MS) {
			players.delete(id);
			removed++;
		}
	}
	return removed;
}
