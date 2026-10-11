import { describe, expect, test } from "bun:test";
import {
	MAX_STROKE_POINTS,
	NOTE_COLORS,
	applyNoteWrite,
	applyStrokeWrite,
	downsample,
	mergeInkWindow,
	reactionAt,
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

describe("ink", () => {
	test("a stroke insert is validated, clamped and stamped; strokes are write-once", () => {
		const stroke = applyStrokeWrite(
			undefined,
			"s1",
			"fox-abc123",
			{ color: "#22c55e", points: [0.1, 0.2, 1.5, -1] },
			42,
		);
		expect(stroke).toEqual({
			id: "s1",
			roomId: "fox-abc123",
			color: "#22c55e",
			points: [0.1, 0.2, 1, 0],
			createdAt: 42,
		});
		if (typeof stroke === "string") throw new Error(stroke);
		expect(
			applyStrokeWrite(stroke, "s1", "fox-abc123", { color: "#22c55e", points: [0, 0, 1, 1] }, 43),
		).toBe("strokes cannot be changed");
		expect(
			applyStrokeWrite(undefined, "s2", "fox-abc123", { color: "red", points: [0, 0, 1, 1] }, 1),
		).toBe("invalid color");
		expect(
			applyStrokeWrite(undefined, "s3", "fox-abc123", { color: "#22c55e", points: [0, 0] }, 1),
		).toBe("a stroke needs at least two points");
		expect(
			applyStrokeWrite(
				undefined,
				"s4",
				"fox-abc123",
				{ color: "#22c55e", points: [0, Number.NaN, 1, 1] },
				1,
			),
		).toBe("a stroke needs at least two points");
	});

	test("long strokes are thinned to the cap, keeping both ends", () => {
		const points = Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? i / 4000 : 0.5));
		const thin = downsample(points);
		expect(thin.length).toBe(MAX_STROKE_POINTS * 2);
		expect(thin.slice(0, 2)).toEqual(points.slice(0, 2));
		expect(thin.slice(-2)).toEqual(points.slice(-2));
	});

	test("overlapping live windows rebuild the stroke, and repair a dropped frame", () => {
		let stroke: number[] = [];
		stroke = mergeInkWindow(stroke, 0, [0.1, 0.1, 0.2, 0.2])!;
		// Frame starting at point 2 was lost; the next window starts at 1 and overlaps.
		stroke = mergeInkWindow(stroke, 1, [0.2, 0.2, 0.3, 0.3, 0.4, 0.4])!;
		expect(stroke).toEqual([0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4]);
		// A window that would leave a gap, or is malformed, is refused.
		expect(mergeInkWindow(stroke, 9, [0.5, 0.5])).toBeNull();
		expect(mergeInkWindow(stroke, 1, [0.5])).toBeNull();
		expect(mergeInkWindow(stroke, -1, [0.5, 0.5])).toBeNull();
	});

	test("reactions travel as an index into a fixed list", () => {
		expect(reactionAt(1)).toBe("🎉");
		expect(reactionAt(9)).toBeNull();
		expect(reactionAt("<img>")).toBeNull();
	});
});
