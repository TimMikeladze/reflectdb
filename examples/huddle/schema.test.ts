import { describe, expect, test } from "bun:test";
import { NOTE_COLORS, applyNoteWrite, isRoomId, starterNotes } from "./schema.ts";

describe("note writes", () => {
	test("an insert clamps to the board, trims text and keeps the palette", () => {
		const note = applyNoteWrite(undefined, "n1", "fox-abc123", {
			text: `  ${"x".repeat(200)}  `,
			x: 4,
			y: -1,
			color: "#000000",
		});
		expect(note).toEqual({
			id: "n1",
			roomId: "fox-abc123",
			text: "x".repeat(140),
			x: 0.96,
			y: 0,
			color: NOTE_COLORS[0],
		});
	});

	test("an update keeps fields it does not send", () => {
		const existing = applyNoteWrite(undefined, "n1", "fox-abc123", { text: "hi", x: 0.2, y: 0.3 });
		if (typeof existing === "string") throw new Error(existing);
		expect(applyNoteWrite(existing, "n1", "fox-abc123", { x: 0.5 })).toMatchObject({
			text: "hi",
			x: 0.5,
			y: 0.3,
		});
	});

	test("a note cannot be moved into another room, and bad room ids are refused", () => {
		const existing = applyNoteWrite(undefined, "n1", "fox-abc123", {});
		if (typeof existing === "string") throw new Error(existing);
		expect(applyNoteWrite(existing, "n1", "owl-zzz999", {})).toBe("note belongs to another room");
		expect(applyNoteWrite(undefined, "n1", "../etc", {})).toBe("invalid room");
		expect(isRoomId("Fox")).toBe(false);
	});

	test("starter notes have fixed ids, so seeding twice writes the same rows", () => {
		expect(starterNotes("fox-abc123").map((n) => n.id)).toEqual(
			starterNotes("fox-abc123").map((n) => n.id),
		);
	});
});
