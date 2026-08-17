import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { createMockTransport } from "./helpers.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type { SyncEvent } from "../../src/server/types.ts";

async function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function connectClient(
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
): Promise<void> {
	transport.connectHandler!(clientId, new Request("https://sync"));
	transport.messageHandler!(clientId, {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId,
		token: "valid",
	});
	await tick();
}

function setup(events: SyncEvent[], ephemeralPerSecond?: number) {
	const transport = createMockTransport();
	const server = createServer({
		db: {},
		transport,
		onEvent: (e) => events.push(e),
	});
	server.auth(async () => ({ userId: "u1" }));
	if (ephemeralPerSecond !== undefined) {
		server.rateLimit({ ephemeralPerSecond });
	}
	server.query("posts", () => Promise.resolve([]), { tables: ["posts"] });
	return { transport, server };
}

describe("ephemeral rate limiting", () => {
	test("drops ephemeral messages past the per-second ceiling", async () => {
		const events: SyncEvent[] = [];
		const { transport, server } = setup(events, 3);

		await connectClient(transport, "sender");
		await connectClient(transport, "watcher");
		for (const c of ["sender", "watcher"]) {
			transport.messageHandler!(c, { type: "sync_declare", table: "posts" });
		}
		await tick();
		transport.sentMessages.length = 0;

		// Each ephemeral message fans out to every room subscriber — unmetered,
		// one client's spam becomes N sends.
		for (let i = 0; i < 10; i++) {
			transport.messageHandler!("sender", {
				type: "ephemeral",
				key: "cursor",
				userId: "u1",
				data: { x: i },
			});
		}
		await tick(30);

		const received = transport.sentMessages.filter(
			(m) => m.clientId === "watcher" && m.message.type === "ephemeral",
		);
		expect(received.length).toBe(3);
		expect(events.filter((e) => e.type === "ephemeral_rate_limited").length).toBe(7);
		await server.close();
	});

	test("is metered by default, without any rateLimit() call", async () => {
		const events: SyncEvent[] = [];
		const { transport, server } = setup(events);

		await connectClient(transport, "sender");
		await connectClient(transport, "watcher");
		for (const c of ["sender", "watcher"]) {
			transport.messageHandler!(c, { type: "sync_declare", table: "posts" });
		}
		await tick();
		transport.sentMessages.length = 0;

		for (let i = 0; i < 200; i++) {
			transport.messageHandler!("sender", {
				type: "ephemeral",
				key: "cursor",
				userId: "u1",
				data: { x: i },
			});
		}
		await tick(50);

		const received = transport.sentMessages.filter(
			(m) => m.clientId === "watcher" && m.message.type === "ephemeral",
		);
		// Default ceiling is 60/s — generous for a 100ms cursor stream.
		expect(received.length).toBe(60);
		await server.close();
	});

	test("ephemeralPerSecond: 0 disables metering", async () => {
		const events: SyncEvent[] = [];
		const { transport, server } = setup(events, 0);

		await connectClient(transport, "sender");
		await connectClient(transport, "watcher");
		for (const c of ["sender", "watcher"]) {
			transport.messageHandler!(c, { type: "sync_declare", table: "posts" });
		}
		await tick();
		transport.sentMessages.length = 0;

		for (let i = 0; i < 100; i++) {
			transport.messageHandler!("sender", {
				type: "ephemeral",
				key: "cursor",
				userId: "u1",
				data: { x: i },
			});
		}
		await tick(50);

		const received = transport.sentMessages.filter(
			(m) => m.clientId === "watcher" && m.message.type === "ephemeral",
		);
		expect(received.length).toBe(100);
		await server.close();
	});

	test("a slow recipient does not block the rest of the fanout", async () => {
		const events: SyncEvent[] = [];
		const { transport, server } = setup(events, 0);

		await connectClient(transport, "sender");
		for (let i = 0; i < 5; i++) await connectClient(transport, `watcher${i}`);
		transport.messageHandler!("sender", { type: "sync_declare", table: "posts" });
		for (let i = 0; i < 5; i++) {
			transport.messageHandler!(`watcher${i}`, { type: "sync_declare", table: "posts" });
		}
		await tick();
		transport.sentMessages.length = 0;

		// One head-of-line blocker; sequential awaits would sum the delays.
		transport.sendDelay = (clientId) => (clientId === "watcher0" ? 40 : 0);

		const started = Date.now();
		transport.messageHandler!("sender", {
			type: "ephemeral",
			key: "cursor",
			userId: "u1",
			data: { x: 1 },
		});
		await tick(80);
		const elapsed = Date.now() - started;

		expect(
			transport.sentMessages.filter((m) => m.message.type === "ephemeral").length,
		).toBe(5);
		expect(elapsed).toBeLessThan(150);
		await server.close();
	});
});
