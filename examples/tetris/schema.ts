/**
 * Infinite-player Tetris — shared protocol and board geometry.
 *
 * There is one perpetual game. Every connected player has a regular 10×20
 * well, and all player snapshots are synchronized to the same global feed.
 * Inputs travel up as tiny writes; authoritative boards travel back down.
 */

import { defineSyncQueries, t, view } from "../../src/core/index.ts";

export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;
export const TICK_MS = 50;
export const KEEPALIVE_MS = 4_000;
export const IDLE_TIMEOUT_MS = 15_000;

export const PIECE_KINDS = ["I", "O", "T", "S", "Z", "J", "L"] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];
export type InputAction =
	| "join"
	| "heartbeat"
	| "left"
	| "right"
	| "rotate-cw"
	| "rotate-ccw"
	| "soft-drop"
	| "hard-drop";

export type Player = {
	id: string;
	name: string;
	/** Settled cells, row-major. 0 is empty; 1-7 map to PIECE_KINDS. */
	board: number[];
	piece: PieceKind;
	next: PieceKind;
	rotation: number;
	x: number;
	y: number;
	score: number;
	lines: number;
	deaths: number;
	action: InputAction;
	/** Latest sequence number sent by the client (optimistically writable). */
	inputSeq: number;
	/** Latest input the server has actually applied; drives client reconciliation. */
	processedSeq: number;
	/** Server-generated upcoming pieces, shared so local prediction stays exact. */
	bag: PieceKind[];
	joinedAt: number;
	lastSeen: number;
};

export type Standing = {
	id: string;
	name: string;
	score: number;
	lines: number;
	deaths: number;
	rank: number;
};

export interface AppAuth extends Record<string, unknown> {
	userId: string;
}

const readonlyPlayerFields = [
	"name",
	"board",
	"piece",
	"next",
	"rotation",
	"x",
	"y",
	"score",
	"lines",
	"deaths",
	"processedSeq",
	"bag",
	"joinedAt",
] as const;

export const queries = defineSyncQueries({
	players: {
		row: t<Player>(),
		conflict: "lww",
		readonly: readonlyPlayerFields,
		serverSet: ["lastSeen"],
	},
	standings: view({
		row: t<Standing>(),
		deps: ["players"],
	}),
});

export interface CellPoint {
	x: number;
	y: number;
}

const BASE_CELLS: Record<PieceKind, readonly CellPoint[]> = {
	I: [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 2, y: 0 },
		{ x: 3, y: 0 },
	],
	O: [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 0, y: 1 },
		{ x: 1, y: 1 },
	],
	T: [
		{ x: 1, y: 0 },
		{ x: 0, y: 1 },
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
	],
	S: [
		{ x: 1, y: 0 },
		{ x: 2, y: 0 },
		{ x: 0, y: 1 },
		{ x: 1, y: 1 },
	],
	Z: [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
	],
	J: [
		{ x: 0, y: 0 },
		{ x: 0, y: 1 },
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
	],
	L: [
		{ x: 2, y: 0 },
		{ x: 0, y: 1 },
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
	],
};

/** Cells occupied by a piece after a normalized quarter-turn rotation. */
export function pieceCells(kind: PieceKind, rotation: number, x = 0, y = 0): CellPoint[] {
	let cells = BASE_CELLS[kind].map((cell) => ({ ...cell }));
	const turns = kind === "O" ? 0 : ((rotation % 4) + 4) % 4;
	for (let turn = 0; turn < turns; turn++) {
		cells = cells.map((cell) => ({ x: -cell.y, y: cell.x }));
		const minX = Math.min(...cells.map((cell) => cell.x));
		const minY = Math.min(...cells.map((cell) => cell.y));
		cells = cells.map((cell) => ({ x: cell.x - minX, y: cell.y - minY }));
	}
	return cells.map((cell) => ({ x: cell.x + x, y: cell.y + y }));
}

export function pieceValue(kind: PieceKind): number {
	return PIECE_KINDS.indexOf(kind) + 1;
}

export function colorFor(id: string): string {
	let hue = 0;
	for (let i = 0; i < id.length; i++) hue = (hue * 31 + id.charCodeAt(i)) % 360;
	return `hsl(${hue} 80% 62%)`;
}
