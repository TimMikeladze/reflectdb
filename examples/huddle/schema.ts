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

export const queries = defineSyncQueries({
	notes: {
		row: t<Note>(),
		params: {} as { roomId: string },
		conflict: "lww",
		readonly: ["roomId"],
	},
});

export const MAX_NOTES_PER_ROOM = 24;
export const MAX_ROOMS = 500;
export const MAX_TEXT = 140;
export const NOTE_COLORS = ["#fde68a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#ddd6fe"] as const;

const ROOM_ID = /^[a-z0-9-]{3,32}$/;

export function isRoomId(value: unknown): value is string {
	return typeof value === "string" && ROOM_ID.test(value);
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
		{ text: "join the huddle for video and screen share", x: 0.64, y: 0.12 },
	].map((note, index) => ({
		id: `${roomId}-starter-${index + 1}`,
		roomId,
		color: NOTE_COLORS[index % NOTE_COLORS.length]!,
		...note,
	}));
}
