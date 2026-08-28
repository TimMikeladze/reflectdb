import { describe, expect, test } from "bun:test";
import { createMemoryDriver } from "../../../../src/server/storage/object/drivers/memory.ts";
import { PreconditionFailedError } from "../../../../src/server/storage/object/types.ts";
import { runObjectDriverSuite } from "./driver-suite.ts";

runObjectDriverSuite("memory", () => createMemoryDriver());
runObjectDriverSuite("memory (casWildcard: false)", () =>
	createMemoryDriver({ casWildcard: false }),
);

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("memory driver: fault injection", () => {
	test("a fault hook can fail one specific call", async () => {
		const boom = new Error("503 Slow Down");
		const driver = createMemoryDriver({
			faults: {
				before: (ctx) => (ctx.op === "put" && ctx.key === "explode" ? { throw: boom } : undefined),
			},
		});

		await driver.put("fine", utf8("v"));
		await expect(driver.put("explode", utf8("v"))).rejects.toBe(boom);
		// A fault before the write leaves state untouched, like a request that
		// never reached the store.
		expect(await driver.get("explode")).toBeNull();
	});

	test("a fault hook can target the Nth put via stats", async () => {
		const driver = createMemoryDriver({
			faults: {
				before: (ctx) =>
					ctx.op === "put" && driver.stats.put === 2 ? { throw: new Error("flush failed") } : undefined,
			},
		});

		await driver.put("a", utf8("1"));
		await expect(driver.put("b", utf8("2"))).rejects.toThrow("flush failed");
		await driver.put("c", utf8("3"));

		expect([...driver.dump().keys()]).toEqual(["a", "c"]);
	});

	test("a fault hook can inject latency", async () => {
		const driver = createMemoryDriver({
			faults: { before: (ctx) => (ctx.op === "get" ? { delayMs: 25 } : undefined) },
		});
		const started = performance.now();
		await driver.get("anything");
		expect(performance.now() - started).toBeGreaterThanOrEqual(20);
	});

	test("the call ordinal counts every operation", async () => {
		const seen: string[] = [];
		const driver = createMemoryDriver({
			faults: {
				before: (ctx) => {
					seen.push(`${ctx.call}:${ctx.op}`);
				},
			},
		});
		await driver.put("a", utf8("1"));
		await driver.get("a");
		await driver.list("");
		await driver.delete(["a"]);
		expect(seen).toEqual(["1:put", "2:get", "3:list", "4:delete"]);
	});
});

describe("memory driver: stats", () => {
	test("counts calls per operation", async () => {
		const driver = createMemoryDriver();
		expect(driver.stats).toEqual({ get: 0, put: 0, list: 0, delete: 0 });

		await driver.put("a", utf8("1"));
		await driver.put("b", utf8("2"));
		await driver.get("a");
		await driver.list("");
		await driver.delete(["a"]);

		expect(driver.stats).toEqual({ get: 1, put: 2, list: 1, delete: 1 });
	});

	test("dump does not disturb the counters", async () => {
		const driver = createMemoryDriver();
		await driver.put("a", utf8("1"));
		driver.dump();
		expect(driver.stats).toEqual({ get: 0, put: 1, list: 0, delete: 0 });
	});
});

describe("memory driver: non-wildcard stores (MinIO)", () => {
	test("ifNoneMatch throws a distinct, non-retryable error", async () => {
		const driver = createMemoryDriver({ casWildcard: false });
		const error = await driver.put("k", utf8("v"), { ifNoneMatch: "*" }).then(
			() => null,
			(e: unknown) => e,
		);
		// Not a PreconditionFailedError: a 412 means "someone moved first, re-read
		// and back off", which an election loop retries forever. "This store cannot
		// do create-if-absent" needs init() at deploy time instead, so the two must
		// be distinguishable.
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(PreconditionFailedError);
		expect((error as Error).message).toContain("init()");
	});

	test("ifMatch still works, which is what init() relies on", async () => {
		const driver = createMemoryDriver({ casWildcard: false });
		const etag = await driver.put("_lease", utf8("unowned"));
		await driver.put("_lease", utf8("owned"), { ifMatch: etag });
		expect(new TextDecoder().decode((await driver.get("_lease"))!.body)).toBe("owned");
	});
});
