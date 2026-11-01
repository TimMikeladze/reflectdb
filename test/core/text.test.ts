import { describe, expect, test } from "bun:test";
import { applyHunks, diffText, hashText, mapOffset, merge3 } from "../../src/core/text.ts";

describe("diffText", () => {
	test("applying the hunks gives the target, for random edits", () => {
		const alphabet = "abc \n";
		const random = (n: number) =>
			Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(
				"",
			);
		for (let i = 0; i < 300; i++) {
			const a = random(Math.floor(Math.random() * 60));
			const b = random(Math.floor(Math.random() * 60));
			expect(applyHunks(a, diffText(a, b))).toBe(b);
		}
	});

	test("a diff past the edit limit is still correct", () => {
		const a = "a".repeat(5000);
		const b = "b".repeat(5000);
		expect(applyHunks(a, diffText(a, b))).toBe(b);
	});
});

describe("merge3", () => {
	test("changes in different places both land", () => {
		expect(merge3("one two three", "ONE two three", "one two THREE")).toBe("ONE two THREE");
	});

	test("the same change lands once", () => {
		expect(merge3("abc", "abXc", "abXc")).toBe("abXc");
	});

	test("two inserts at one spot both land, ours first", () => {
		expect(merge3("ab", "aXb", "aYb")).toBe("aXYb");
	});

	test("overlapping deletes remove the union and keep inserts", () => {
		expect(merge3("abcdef", "aXdef", "abYef")).toBe("aXYef");
	});

	test("one side unchanged returns the other", () => {
		expect(merge3("abc", "abc", "abcd")).toBe("abcd");
		expect(merge3("abc", "abcd", "abc")).toBe("abcd");
	});
});

describe("mapOffset", () => {
	test("text before the offset moves it, text after doesn't", () => {
		expect(mapOffset("hello", "XXhello", 3)).toBe(5);
		expect(mapOffset("hello", "helloXX", 3)).toBe(3);
	});

	test("an insert exactly at the offset leaves it before the insert", () => {
		expect(mapOffset("ab", "aXb", 1)).toBe(1);
	});

	test("an offset inside a deleted range lands where the range was", () => {
		expect(mapOffset("abcdef", "af", 3)).toBe(1);
	});
});

test("hashText tells different text apart", () => {
	expect(hashText("abc")).toBe(hashText("abc"));
	expect(hashText("abc")).not.toBe(hashText("abd"));
});
