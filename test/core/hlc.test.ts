import { describe, expect, test } from "bun:test";
import {
	compareHlc,
	createHlc,
	packHlc,
	receiveHlc,
	sendHlc,
	unpackHlc,
} from "../../src/core/hlc.ts";

describe("HLC", () => {
	describe("createHlc", () => {
		test("creates an HLC with zero state", () => {
			const hlc = createHlc("client:abc");
			expect(hlc.ms).toBe(0);
			expect(hlc.counter).toBe(0);
			expect(hlc.nodeId).toBe("client:abc");
		});
	});

	describe("sendHlc", () => {
		test("advances to wall time when ahead of local", () => {
			const local = createHlc("client:abc");
			const result = sendHlc(local);
			expect(result.ms).toBeGreaterThan(0);
			expect(result.counter).toBe(0);
			expect(result.nodeId).toBe("client:abc");
		});

		test("increments counter when wall time equals local", () => {
			const now = Date.now();
			const local = { ms: now + 10000, counter: 5, nodeId: "client:abc" };
			const result = sendHlc(local);
			expect(result.ms).toBe(now + 10000);
			expect(result.counter).toBe(6);
		});

		test("produces monotonically increasing packed strings", () => {
			let local = createHlc("client:abc");
			const packed: string[] = [];
			for (let i = 0; i < 100; i++) {
				local = sendHlc(local);
				packed.push(packHlc(local));
			}
			for (let i = 1; i < packed.length; i++) {
				expect(packed[i]! > packed[i - 1]!).toBe(true);
			}
		});
	});

	describe("receiveHlc", () => {
		test("advances to remote ms when remote is ahead", () => {
			const local = createHlc("client:abc");
			const remote = {
				ms: Date.now() + 1000,
				counter: 3,
				nodeId: "client:other",
			};
			const result = receiveHlc(local, remote);
			expect(result.ms).toBe(remote.ms);
			expect(result.counter).toBe(4);
			expect(result.nodeId).toBe("client:abc");
		});

		test("clamps remote ms that exceeds drift window", () => {
			const now = Date.now();
			const local = createHlc("client:abc");
			const remote = {
				ms: now + 999_999_999,
				counter: 0,
				nodeId: "client:evil",
			};
			const result = receiveHlc(local, remote);
			// Should be clamped to now + MAX_CLOCK_DRIFT (5 min)
			expect(result.ms).toBeLessThanOrEqual(now + 5 * 60 * 1000 + 100);
		});

		test("merges counters when local and remote ms are equal", () => {
			const ms = Date.now() + 5000;
			const local = { ms, counter: 3, nodeId: "client:abc" };
			const remote = { ms, counter: 7, nodeId: "client:other" };
			const result = receiveHlc(local, remote);
			expect(result.ms).toBe(ms);
			expect(result.counter).toBe(8);
		});

		test("preserves local nodeId", () => {
			const local = { ms: 100, counter: 0, nodeId: "client:mine" };
			const remote = { ms: 200, counter: 0, nodeId: "client:theirs" };
			const result = receiveHlc(local, remote);
			expect(result.nodeId).toBe("client:mine");
		});
	});

	describe("packHlc / unpackHlc", () => {
		test("roundtrips correctly", () => {
			const hlc = { ms: 1712000000000, counter: 42, nodeId: "client:abc123" };
			const packed = packHlc(hlc);
			const unpacked = unpackHlc(packed);
			expect(unpacked).toEqual(hlc);
		});

		test("produces fixed-width format", () => {
			const hlc = { ms: 1712000000000, counter: 1, nodeId: "client:abc" };
			const packed = packHlc(hlc);
			// 19 digits . 4 digits . nodeId
			expect(packed).toBe("0000001712000000000.0001.client:abc");
		});

		test("lexicographic order matches causal order", () => {
			const a = packHlc({ ms: 100, counter: 0, nodeId: "client:a" });
			const b = packHlc({ ms: 100, counter: 1, nodeId: "client:b" });
			const c = packHlc({ ms: 101, counter: 0, nodeId: "client:a" });
			expect(a < b).toBe(true);
			expect(b < c).toBe(true);
		});

		test("same ms different counters sort correctly", () => {
			const a = packHlc({ ms: 1000, counter: 9, nodeId: "client:a" });
			const b = packHlc({ ms: 1000, counter: 10, nodeId: "client:a" });
			expect(a < b).toBe(true);
		});
	});

	describe("compareHlc", () => {
		test("returns -1 when a < b", () => {
			const a = packHlc({ ms: 100, counter: 0, nodeId: "client:a" });
			const b = packHlc({ ms: 200, counter: 0, nodeId: "client:a" });
			expect(compareHlc(a, b)).toBe(-1);
		});

		test("returns 1 when a > b", () => {
			const a = packHlc({ ms: 200, counter: 0, nodeId: "client:a" });
			const b = packHlc({ ms: 100, counter: 0, nodeId: "client:a" });
			expect(compareHlc(a, b)).toBe(1);
		});

		test("returns 0 when equal", () => {
			const a = packHlc({ ms: 100, counter: 0, nodeId: "client:a" });
			expect(compareHlc(a, a)).toBe(0);
		});

		test("breaks ties by counter", () => {
			const a = packHlc({ ms: 100, counter: 1, nodeId: "client:a" });
			const b = packHlc({ ms: 100, counter: 2, nodeId: "client:a" });
			expect(compareHlc(a, b)).toBe(-1);
		});

		test("breaks ties by nodeId when ms and counter equal", () => {
			const a = packHlc({ ms: 100, counter: 1, nodeId: "client:aaa" });
			const b = packHlc({ ms: 100, counter: 1, nodeId: "client:bbb" });
			expect(compareHlc(a, b)).toBe(-1);
		});
	});

	describe("unpackHlc malformed input", () => {
		test("throws on missing dots", () => {
			expect(() => unpackHlc("notahlc")).toThrow(/Malformed HLC/);
		});
		test("throws on single dot", () => {
			expect(() => unpackHlc("100.0001")).toThrow(/Malformed HLC/);
		});
		test("throws on non-numeric ms", () => {
			expect(() => unpackHlc("abc.0001.node")).toThrow(/Malformed HLC/);
		});
		test("throws on empty nodeId", () => {
			expect(() => unpackHlc("100.0001.")).toThrow(/Malformed HLC/);
		});
	});
});
