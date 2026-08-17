import { describe, expect, test } from "bun:test";
import { ReplayDetector } from "../../src/server/replay-detector.ts";

describe("ReplayDetector (no storage)", () => {
	test("first sighting returns true", async () => {
		const r = new ReplayDetector(null);
		expect(await r.reserve("op-1")).toBe(true);
	});

	test("second sighting returns false (replay)", async () => {
		const r = new ReplayDetector(null);
		await r.reserve("op-1");
		expect(await r.reserve("op-1")).toBe(false);
	});

	test("distinct opIds are independent", async () => {
		const r = new ReplayDetector(null);
		expect(await r.reserve("a")).toBe(true);
		expect(await r.reserve("b")).toBe(true);
		expect(await r.reserve("a")).toBe(false);
		expect(await r.reserve("b")).toBe(false);
	});
});

describe("ReplayDetector (with storage)", () => {
	test("delegates to storage.reserveOp", async () => {
		const calls: string[] = [];
		const stub = {
			reserveOp: async (opId: string) => {
				calls.push(opId);
				return calls.filter((c) => c === opId).length === 1;
			},
		};
		const r = new ReplayDetector(stub as never);
		expect(await r.reserve("x")).toBe(true);
		expect(await r.reserve("x")).toBe(false);
		expect(calls).toEqual(["x", "x"]);
	});

	test("setStorage swaps backend", async () => {
		const r = new ReplayDetector(null);
		expect(await r.reserve("a")).toBe(true);

		let storageCalled = false;
		const stub = {
			reserveOp: async () => {
				storageCalled = true;
				return true;
			},
		};
		r.setStorage(stub as never);
		expect(await r.reserve("a")).toBe(true); // storage says fresh, in-mem ignored
		expect(storageCalled).toBe(true);
	});
});
