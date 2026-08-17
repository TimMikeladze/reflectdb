import { describe, expect, test } from "bun:test";
import { advancePaddles } from "./interpolate.ts";
import { TAU, angleDiff, norm } from "./schema.ts";

const FRAME = 1 / 60;

function run(
	target: number,
	frames: number,
	start?: number,
	dt = FRAME,
): { smooth: Map<string, number>; samples: number[] } {
	const smooth = new Map<string, number>();
	if (start !== undefined) smooth.set("p1", start);
	const samples: number[] = [];
	for (let i = 0; i < frames; i++) {
		advancePaddles([{ id: "p1", angle: target }], smooth, "self", 0, dt);
		samples.push(smooth.get("p1")!);
	}
	return { smooth, samples };
}

describe("advancePaddles", () => {
	test("a paddle appears where it is, not sweeping in from zero", () => {
		const { smooth } = run(2.5, 1);
		expect(smooth.get("p1")).toBe(2.5);
	});

	test("eases toward the target and converges", () => {
		const { samples } = run(1, 60, 0);

		// Motion on every frame, no teleport: the first step is a fraction of the
		// gap, not the whole gap.
		expect(samples[0]!).toBeGreaterThan(0);
		expect(samples[0]!).toBeLessThan(0.4);
		// Monotonic approach.
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
		}
		// ~100 ms (6 frames) gets most of the way there; a second is basically exact.
		expect(samples[5]!).toBeGreaterThan(0.25);
		expect(samples[59]!).toBeCloseTo(1, 3);
	});

	test("takes the short way around the circle", () => {
		// From 0.1 rad to 6.2 rad is 0.18 rad backwards, not 6.1 forwards.
		const { samples } = run(6.2, 30, 0.1);
		for (const s of samples) {
			// Never wanders into the far side of the circle.
			expect(Math.abs(angleDiff(s, 0.15))).toBeLessThan(0.5);
			expect(s).toBeGreaterThanOrEqual(0);
			expect(s).toBeLessThan(TAU);
		}
		expect(Math.abs(angleDiff(samples[29]!, 6.2))).toBeLessThan(0.01);
	});

	test("is frame-rate independent", () => {
		// Same elapsed time, different frame budgets — same place, near enough.
		const fast = run(1, 60, 0, 1 / 60).smooth.get("p1")!;
		const slow = run(1, 20, 0, 1 / 20).smooth.get("p1")!;
		expect(Math.abs(fast - slow)).toBeLessThan(0.01);
	});

	test("never eases the local player — their input is already local", () => {
		const smooth = new Map<string, number>();
		advancePaddles([{ id: "self", angle: 0 }], smooth, "self", 2.2, FRAME);
		expect(smooth.get("self")).toBe(2.2);

		advancePaddles([{ id: "self", angle: 0 }], smooth, "self", 0.4, FRAME);
		expect(smooth.get("self")).toBe(0.4);
	});

	test("forgets players who left", () => {
		const smooth = new Map<string, number>();
		advancePaddles(
			[
				{ id: "a", angle: 1 },
				{ id: "b", angle: 2 },
			],
			smooth,
			"self",
			0,
			FRAME,
		);
		expect([...smooth.keys()].sort()).toEqual(["a", "b"]);

		advancePaddles([{ id: "a", angle: 1 }], smooth, "self", 0, FRAME);
		expect([...smooth.keys()]).toEqual(["a"]);
	});

	test("stays normalized while chasing a wrapping target", () => {
		const smooth = new Map<string, number>();
		let target = 0;
		for (let i = 0; i < 600; i++) {
			target = norm(target + 0.05); // a paddle spinning through the wrap point
			advancePaddles([{ id: "p1", angle: target }], smooth, "self", 0, FRAME);
			const v = smooth.get("p1")!;
			expect(Number.isFinite(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(TAU);
		}
		// Tracking it, not lost on the far side.
		expect(Math.abs(angleDiff(smooth.get("p1")!, target))).toBeLessThan(0.2);
	});
});
