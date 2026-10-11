/** Shared between the sync server and the browser bundle. */

import { defineSyncQueries, t } from "../../src/core/index.ts";

/**
 * A type alias, not an interface: `t<Row>()` needs the implicit index
 * signature only type aliases get.
 */
export type Note = {
	id: string;
	roomId: string;
	text: string;
	/** Position as a fraction of the board, 0–1, so every screen size agrees. */
	x: number;
	y: number;
	color: string;
};

/** A finished ink stroke. Points are flattened `[x0, y0, x1, y1, …]`, fractions of the board. */
export type Stroke = {
	id: string;
	roomId: string;
	color: string;
	points: number[];
	/** Server-stamped; strokes expire STROKE_TTL_MS after this. */
	createdAt: number;
};

export const queries = defineSyncQueries({
	notes: {
		row: t<Note>(),
		params: {} as { roomId: string },
		conflict: "lww",
		readonly: ["roomId"],
	},
	strokes: {
		row: t<Stroke>(),
		params: {} as { roomId: string },
		conflict: "lww",
		readonly: ["roomId"],
		serverSet: ["createdAt"],
	},
});

export const MAX_NOTES_PER_ROOM = 24;
/** A room's notes are a few KB, so this bounds memory well under the 256 MB Machine. */
export const MAX_ROOMS = 2_000;
/** A room nobody has read or written for this long is cleared, freeing its slot. */
export const ROOM_IDLE_MS = 30 * 60_000;
export const MAX_TEXT = 140;
/** Oldest strokes are evicted past this, so a room's ink cannot grow without bound. */
export const MAX_STROKES_PER_ROOM = 120;
/** Points per stroke, as x/y pairs; longer strokes are downsampled before saving. */
export const MAX_STROKE_POINTS = 400;
/** Ink fades out of the room after this. */
export const STROKE_TTL_MS = 10 * 60_000;
/** Reactions, by index: peers send the index, never the text. */
export const REACTIONS = ["👍", "🎉", "❤️", "😂", "🔥"] as const;
export const NOTE_COLORS = ["#fde68a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#ddd6fe"] as const;

const ROOM_ID = /^[a-z0-9-]{3,32}$/;

export function isRoomId(value: unknown): value is string {
	return typeof value === "string" && ROOM_ID.test(value);
}

/** Note ids are Map keys held in memory, so their length is bounded too. */
const NOTE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isNoteId(value: unknown): value is string {
	return typeof value === "string" && NOTE_ID.test(value);
}

function clamp01(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(0.96, Math.max(0, value))
		: fallback;
}

/**
 * The note a write produces, or an error message. Pure, so the rules are
 * testable without a server: positions clamp to the board, text is trimmed and
 * capped, colors come from the palette, and the room is fixed at insert.
 */
export function applyNoteWrite(
	existing: Note | undefined,
	rowId: string,
	roomId: string,
	payload: Partial<Note>,
): Note | string {
	if (!isRoomId(roomId)) return "invalid room";
	if (!isNoteId(rowId)) return "invalid note id";
	if (existing && existing.roomId !== roomId) return "note belongs to another room";
	const base: Note = existing ?? {
		id: rowId,
		roomId,
		text: "",
		x: 0.4,
		y: 0.4,
		color: NOTE_COLORS[0],
	};
	const color =
		typeof payload.color === "string" && (NOTE_COLORS as readonly string[]).includes(payload.color)
			? payload.color
			: base.color;
	return {
		id: rowId,
		roomId,
		text: typeof payload.text === "string" ? payload.text.trim().slice(0, MAX_TEXT) : base.text,
		x: clamp01(payload.x, base.x),
		y: clamp01(payload.y, base.y),
		color,
	};
}

/** Starter notes for an empty room. Fixed ids, so two tabs seeding at once write the same rows. */
export function starterNotes(roomId: string): Note[] {
	return [
		{ text: "open this room in a second tab", x: 0.06, y: 0.1 },
		{ text: "drag me: the preview is peer-to-peer, the drop is a synced op", x: 0.36, y: 0.32 },
		{ text: "press D and draw: the ink streams peer-to-peer · keys 1–5 react", x: 0.64, y: 0.12 },
	].map((note, index) => ({
		id: `${roomId}-starter-${index + 1}`,
		roomId,
		color: NOTE_COLORS[index % NOTE_COLORS.length]!,
		...note,
	}));
}

// ── Peer input ─────────────────────────────────────────────────────────

/**
 * Colors arrive from peers and land in `style`; anything but a hex color (a
 * `url(…)`, say, which would make every viewer fetch it) is replaced.
 */
export function safeColor(value: unknown): string {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#777777";
}

/** A peer could send an object as a name; React would throw rendering it and take the tab down. */
export function safeName(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 32) : fallback;
}

export function isPoint(
	value: { x?: unknown; y?: unknown } | undefined,
): value is { x: number; y: number } {
	return !!value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

// ── Ink ────────────────────────────────────────────────────────────────

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Clamp, round and validate flattened points; null if the list is not a usable stroke. */
export function cleanPoints(value: unknown, maxPairs = MAX_STROKE_POINTS): number[] | null {
	if (!Array.isArray(value) || value.length % 2 !== 0 || value.length < 2) return null;
	if (value.length > maxPairs * 2) return null;
	const out: number[] = [];
	for (const n of value) {
		if (typeof n !== "number" || !Number.isFinite(n)) return null;
		out.push(Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000);
	}
	return out;
}

/** The stroke an insert produces, or an error message. Strokes are write-once. */
export function applyStrokeWrite(
	existing: Stroke | undefined,
	rowId: string,
	roomId: string,
	payload: Partial<Stroke>,
	now: number,
): Stroke | string {
	if (!isRoomId(roomId)) return "invalid room";
	if (!isNoteId(rowId)) return "invalid stroke id";
	if (existing) return "strokes cannot be changed";
	const points = cleanPoints(payload.points);
	if (!points || points.length < 4) return "a stroke needs at least two points";
	if (typeof payload.color !== "string" || !HEX_COLOR.test(payload.color)) return "invalid color";
	return { id: rowId, roomId, color: payload.color, points, createdAt: now };
}

/** Thin a long stroke to at most `maxPairs` points, keeping both ends. */
export function downsample(points: number[], maxPairs = MAX_STROKE_POINTS): number[] {
	const pairs = points.length / 2;
	if (pairs <= maxPairs) return points;
	const out: number[] = [];
	for (let i = 0; i < maxPairs; i++) {
		const source = Math.round((i * (pairs - 1)) / (maxPairs - 1));
		out.push(points[source * 2]!, points[source * 2 + 1]!);
	}
	return out;
}

/**
 * Live ink arrives as overlapping windows of the stroke's latest points, each
 * tagged with where it starts. Writing each window at its offset rebuilds the
 * stroke, and the overlap repairs a frame the unreliable channel dropped.
 * Returns null for a window that is malformed or would grow the stroke past
 * the cap.
 */
export function mergeInkWindow(stroke: number[], start: unknown, window: unknown): number[] | null {
	if (typeof start !== "number" || !Number.isInteger(start) || start < 0) return null;
	const points = cleanPoints(window, 64);
	if (!points) return null;
	const offset = start * 2;
	if (offset > stroke.length || offset + points.length > MAX_STROKE_POINTS * 4) return null;
	const merged = stroke.slice(0, Math.max(stroke.length, offset + points.length));
	for (let i = 0; i < points.length; i++) merged[offset + i] = points[i]!;
	return merged;
}

export function reactionAt(index: unknown): string | null {
	return typeof index === "number" && Number.isInteger(index) ? (REACTIONS[index] ?? null) : null;
}
