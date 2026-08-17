import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { createMockTransport } from "./helpers.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("server.lock", () => {
	test("serializes calls on the same key", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		const order: string[] = [];
		const d1 = deferred<void>();
		const d2 = deferred<void>();

		const p1 = server.lock("a", async () => {
			order.push("f1-start");
			await d1.promise;
			order.push("f1-end");
		});
		const p2 = server.lock("a", async () => {
			order.push("f2-start");
			await d2.promise;
			order.push("f2-end");
		});
		const p3 = server.lock("a", async () => {
			order.push("f3-start");
			order.push("f3-end");
		});

		// Yield a tick — only f1 should be running.
		await Bun.sleep(10);
		expect(order).toEqual(["f1-start"]);

		d1.resolve();
		await Bun.sleep(10);
		expect(order).toEqual(["f1-start", "f1-end", "f2-start"]);

		d2.resolve();
		await Promise.all([p1, p2, p3]);
		expect(order).toEqual([
			"f1-start",
			"f1-end",
			"f2-start",
			"f2-end",
			"f3-start",
			"f3-end",
		]);

		await server.close();
	});

	test("different keys are independent", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		const order: string[] = [];
		const slowDone = deferred<void>();

		const slow = server.lock("a", async () => {
			order.push("slow-start");
			await slowDone.promise;
			order.push("slow-end");
		});

		const fast = server.lock("b", async () => {
			order.push("fast-start");
			order.push("fast-end");
		});

		await fast;
		expect(order).toEqual(["slow-start", "fast-start", "fast-end"]);

		slowDone.resolve();
		await slow;

		await server.close();
	});

	test("tryLock runs immediately when key is free", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		const result = await server.tryLock("k", async () => 42);
		expect(result).toBe(42);

		await server.close();
	});

	test("tryLock returns null when key is held", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		const d = deferred<void>();
		const held = server.lock("k", async () => {
			await d.promise;
		});

		const skipped = await server.tryLock("k", async () => "ran");
		expect(skipped).toBeNull();

		d.resolve();
		await held;

		await server.close();
	});

	test("after fn throws, the chain still cleans up", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		await expect(
			server.lock("k", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		// Next lock proceeds.
		const result = await server.lock("k", async () => "ok");
		expect(result).toBe("ok");

		await server.close();
	});

	test("after fn resolves, map entry is gone (tryLock proceeds)", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		await server.lock("k", async () => "first");

		// Map should be empty now → tryLock runs (returns "second", not null).
		const second = await server.tryLock("k", async () => "second");
		expect(second).toBe("second");

		await server.close();
	});
});
