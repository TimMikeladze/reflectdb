import { describe, expect, test } from "bun:test";
import {
	NOTE_COLORS,
	applyNoteWrite,
	isPoint,
	isRoomId,
	safeColor,
	safeName,
	starterNotes,
} from "./schema.ts";

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
		expect(applyNoteWrite(undefined, "x".repeat(65), "fox-abc123", {})).toBe("invalid note id");
	});

	test("starter notes have fixed ids, so seeding twice writes the same rows", () => {
		expect(starterNotes("fox-abc123").map((n) => n.id)).toEqual(
			starterNotes("fox-abc123").map((n) => n.id),
		);
	});
});

describe("input from peers", () => {
	test("only hex colors reach a style; a url() would make every viewer fetch it", () => {
		expect(safeColor("#22c55e")).toBe("#22c55e");
		expect(safeColor("url(https://evil.example/x)")).toBe("#777777");
		expect(safeColor({ toString: () => "#fff" })).toBe("#777777");
	});

	test("a name that is not a string falls back instead of crashing the render", () => {
		expect(safeName({ $$typeof: "x" }, "guest")).toBe("guest");
		expect(safeName("  brisk otter  ", "guest")).toBe("brisk otter");
		expect(safeName("x".repeat(100), "guest")).toHaveLength(32);
	});

	test("positions must be finite numbers", () => {
		expect(isPoint({ x: 0.2, y: 0.4 })).toBe(true);
		expect(isPoint({ x: "0.2", y: 0.4 })).toBe(false);
		expect(isPoint({ x: Number.NaN, y: 0 })).toBe(false);
		expect(isPoint(undefined)).toBe(false);
	});
});
