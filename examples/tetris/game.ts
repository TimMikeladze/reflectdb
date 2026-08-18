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

export interface RuntimePlayer extends Player {
	fallElapsedMs: number;
}

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

function takePiece(player: Pick<RuntimePlayer, "bag">, random: () => number): PieceKind {
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
): RuntimePlayer {
	const player: RuntimePlayer = {
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
		fallElapsedMs: 0,
	};
	player.piece = takePiece(player, random);
	player.next = takePiece(player, random);
	player.x = spawnX(player.piece);
	return player;
}

export function publicPlayer(player: RuntimePlayer): Player {
	const { fallElapsedMs: _fallElapsedMs, ...row } = player;
	return { ...row, board: [...row.board], bag: [...row.bag] };
}

/** Rebuild the immediate client view from a server snapshot plus unacked keys. */
export function replayInputs(
	authoritative: Player,
	inputs: readonly SequencedInput[],
): RuntimePlayer {
	const predicted: RuntimePlayer = {
		...authoritative,
		board: [...authoritative.board],
		bag: [...authoritative.bag],
		fallElapsedMs: 0,
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

function clearLines(player: RuntimePlayer): number {
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

function resetAfterDeath(player: RuntimePlayer, random: () => number): void {
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
	player.fallElapsedMs = 0;
}

/** Spawn the queued piece; a blocked spawn is a death and immediate fresh run. */
export function spawnNext(player: RuntimePlayer, random = Math.random): boolean {
	player.piece = player.next;
	player.next = takePiece(player, random);
	player.rotation = 0;
	player.x = spawnX(player.piece);
	player.y = 0;
	player.fallElapsedMs = 0;
	if (canPlace(player, player.piece, player.rotation, player.x, player.y)) return false;
	resetAfterDeath(player, random);
	return true;
}

/** Settle the active piece, clear rows, score them, and continue with the queue. */
export function lockPiece(player: RuntimePlayer, random = Math.random): boolean {
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

function move(player: RuntimePlayer, dx: number, dy: number): boolean {
	if (!canPlace(player, player.piece, player.rotation, player.x + dx, player.y + dy)) {
		return false;
	}
	player.x += dx;
	player.y += dy;
	return true;
}

function rotate(player: RuntimePlayer, direction: 1 | -1): boolean {
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
export function applyInput(
	player: RuntimePlayer,
	action: InputAction,
	random = Math.random,
): boolean {
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
			if (move(player, 0, 1)) {
				player.score++;
				return true;
			}
			lockPiece(player, random);
			return true;
		case "hard-drop": {
			const start = player.y;
			player.y = landingY(player);
			player.score += (player.y - start) * 2;
			lockPiece(player, random);
			return true;
		}
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

/** Advance gravity. Large pauses are capped so background tabs cannot cause storms. */
export function advancePlayer(
	player: RuntimePlayer,
	elapsedMs: number,
	random = Math.random,
): boolean {
	player.fallElapsedMs += Math.min(Math.max(elapsedMs, 0), 1_000);
	let changed = false;
	let steps = 0;
	while (player.fallElapsedMs >= gravityMs(player.lines) && steps++ < 12) {
		player.fallElapsedMs -= gravityMs(player.lines);
		if (!move(player, 0, 1)) lockPiece(player, random);
		changed = true;
	}
	return changed;
}

export function reap(players: Map<string, RuntimePlayer>, now: number): number {
	let removed = 0;
	for (const [id, player] of players) {
		if (now - player.lastSeen > IDLE_TIMEOUT_MS) {
			players.delete(id);
			removed++;
		}
	}
	return removed;
}
