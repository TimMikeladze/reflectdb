import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { createMockTransport } from "./helpers.ts";

describe("server.interval / server.timeout", () => {
	test("interval fires multiple times within a window", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		let fires = 0;
		const handle = server.interval(10, () => {
			fires++;
		});

		await Bun.sleep(55);
		handle.clear();

		expect(fires).toBeGreaterThanOrEqual(3);
		await server.close();
	});

	test("clear() stops further fires", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		let fires = 0;
		const handle = server.interval(10, () => {
			fires++;
		});

		await Bun.sleep(25);
		handle.clear();
		const fixed = fires;
		await Bun.sleep(40);

		expect(fires).toBe(fixed);
		await server.close();
	});

	test("timeout fires once", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		let fires = 0;
		server.timeout(10, () => {
			fires++;
		});

		await Bun.sleep(50);
		expect(fires).toBe(1);
		await server.close();
	});

	test("timeout.clear() before fire prevents firing", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		let fires = 0;
		const handle = server.timeout(30, () => {
			fires++;
		});
		handle.clear();

		await Bun.sleep(50);
		expect(fires).toBe(0);
		await server.close();
	});

	test("server.close() clears all active timers", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		let intervalFires = 0;
		let timeoutFires = 0;
		server.interval(10, () => {
			intervalFires++;
		});
		server.timeout(20, () => {
			timeoutFires++;
		});

		await server.close();
		const before = { intervalFires, timeoutFires };
		await Bun.sleep(50);
		expect(intervalFires).toBe(before.intervalFires);
		expect(timeoutFires).toBe(before.timeoutFires);
	});

	test("async fn that throws does not crash the process", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });

		// Track unhandled rejections.
		let unhandled = 0;
		const onUnhandled = () => {
			unhandled++;
		};
		process.on("unhandledRejection", onUnhandled);

		// Silence the expected console.error.
		const origErr = console.error;
		const errs: unknown[] = [];
		console.error = (...args: unknown[]) => {
			errs.push(args);
		};

		try {
			let fires = 0;
			const handle = server.interval(10, async () => {
				fires++;
				throw new Error("boom");
			});

			await Bun.sleep(45);
			handle.clear();
			expect(fires).toBeGreaterThanOrEqual(2);
			expect(unhandled).toBe(0);
			expect(errs.length).toBeGreaterThanOrEqual(1);
		} finally {
			console.error = origErr;
			process.off("unhandledRejection", onUnhandled);
			await server.close();
		}
	});
});
