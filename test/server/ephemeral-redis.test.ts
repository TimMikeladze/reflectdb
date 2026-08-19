import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { createRedisEphemeral } from "../../src/server/ephemeral/redis.ts";
import type { EphemeralBroadcast } from "../../src/server/ephemeral/types.ts";

/**
 * Runs against a real Redis — the adapter's correctness lives in Lua, which a
 * fake cannot exercise. Skipped, not failed, when no server is reachable:
 *
 *   docker run -d --rm -p 6399:6379 redis:7-alpine
 */
const REDIS_URL = process.env.REFLECTDB_TEST_REDIS_URL ?? "redis://localhost:6399";

async function redisAvailable(): Promise<boolean> {
	try {
		const probe = new RedisClient(REDIS_URL);
		await probe.connect();
		await probe.send("PING", []);
		probe.close();
		return true;
	} catch {
		return false;
	}
}

const available = await redisAvailable();
const describeRedis = available ? describe : describe.skip;

if (!available) {
	console.warn(`[test] Redis unreachable at ${REDIS_URL} — skipping Redis ephemeral suite`);
}

const connections: RedisClient[] = [];

function connect(): RedisClient {
	const client = new RedisClient(REDIS_URL);
	connections.push(client);
	return client;
}

/** Bun takes raw commands as (command, string[]); the adapter uses varargs. */
function callShim(client: RedisClient) {
	return {
		call: (command: string, ...args: (string | number)[]) =>
			client.send(command, args.map(String)) as Promise<unknown>,
	};
}

function subscriberShim(client: RedisClient) {
	return {
		subscribe: (channel: string, onMessage: (payload: string) => void) =>
			client.subscribe(channel, (message: string) => onMessage(message)),
	};
}

afterAll(() => {
	for (const client of connections) {
		try {
			client.close();
		} catch {
			// Connection may already be gone; nothing to salvage.
		}
	}
});

describeRedis("redis ephemeral adapter", () => {
	let prefix: string;
	let client: RedisClient;

	beforeEach(async () => {
		client = connect();
		await client.connect();
		// Per-test namespace: parallel runs and leftovers from a failed run must
		// not leak into each other's counters.
		prefix = `reflectdb:test:${crypto.randomUUID()}`;
	});

	function adapter(overrides: { maxEntries?: number } = {}) {
		return createRedisEphemeral({
			client: callShim(client),
			prefix,
			...overrides,
		});
	}

	test("stores and reads back an entry", async () => {
		const store = adapter();

		expect(await store.set("room1", "cursor", "c1", "u1", { x: 1 })).toBe(true);

		const entries = await store.get("room1", "cursor");
		expect(Object.keys(entries)).toEqual(["c1"]);
		expect(entries.c1!.data).toEqual({ x: 1 });
		expect(entries.c1!.userId).toBe("u1");
		expect(await store.size()).toBe(1);
	});

	test("counts updates as updates, not new entries", async () => {
		const store = adapter();

		await store.set("room1", "cursor", "c1", "u1", { x: 1 });
		await store.set("room1", "cursor", "c1", "u1", { x: 2 });
		await store.set("room1", "cursor", "c1", "u1", { x: 3 });

		expect(await store.size()).toBe(1);
		expect((await store.get("room1", "cursor")).c1!.data).toEqual({ x: 3 });
	});

	test("rejects new entries at capacity but still accepts updates", async () => {
		const store = adapter({ maxEntries: 2 });

		expect(await store.set("room1", "cursor", "c1", "u1", { x: 1 })).toBe(true);
		expect(await store.set("room1", "cursor", "c2", "u2", { x: 2 })).toBe(true);
		expect(await store.set("room1", "cursor", "c3", "u3", { x: 3 })).toBe(false);

		// Existing identity can still move — only growth is capped.
		expect(await store.set("room1", "cursor", "c1", "u1", { x: 9 })).toBe(true);
		expect(await store.size()).toBe(2);
	});

	test("getRoom returns every channel in the room", async () => {
		const store = adapter();

		await store.set("room1", "cursor", "c1", "u1", { x: 1 });
		await store.set("room1", "typing", "c1", "u1", { on: true });
		await store.set("room2", "cursor", "c2", "u2", { x: 2 });

		const room1 = await store.getRoom("room1");
		expect(Object.keys(room1).sort()).toEqual(["cursor", "typing"]);
		expect(room1.cursor!.c1!.data).toEqual({ x: 1 });

		const room2 = await store.getRoom("room2");
		expect(Object.keys(room2)).toEqual(["cursor"]);
	});

	test("remove drops the entry and decrements the counter", async () => {
		const store = adapter();

		await store.set("room1", "cursor", "c1", "u1", { x: 1 });
		await store.set("room1", "cursor", "c2", "u2", { x: 2 });
		await store.remove("room1", "cursor", "c1");

		expect(Object.keys(await store.get("room1", "cursor"))).toEqual(["c2"]);
		expect(await store.size()).toBe(1);

		// Removing again must not drive the counter negative.
		await store.remove("room1", "cursor", "c1");
		expect(await store.size()).toBe(1);
	});

	test("removeClient drops every entry that client published", async () => {
		const store = adapter();

		await store.set("room1", "cursor", "c1", "u1", { x: 1 });
		await store.set("room1", "typing", "c1", "u1", { on: true });
		await store.set("room2", "cursor", "c1", "u1", { x: 5 });
		await store.set("room1", "cursor", "c2", "u2", { x: 2 });

		await store.removeClient("c1");

		expect(Object.keys(await store.get("room1", "cursor"))).toEqual(["c2"]);
		expect(await store.get("room1", "typing")).toEqual({});
		expect(await store.get("room2", "cursor")).toEqual({});
		expect(await store.size()).toBe(1);
	});

	test("two tabs from one account are two peers", async () => {
		const store = adapter();

		await store.set("room1", "cursor", "tab-a", "u1", { x: 1 });
		await store.set("room1", "cursor", "tab-b", "u1", { x: 2 });
		expect(await store.size()).toBe(2);

		// One tab closing must not evict the other's cursor.
		await store.removeClient("tab-a");
		const remaining = await store.get("room1", "cursor");
		expect(Object.keys(remaining)).toEqual(["tab-b"]);
		expect(remaining["tab-b"]!.data).toEqual({ x: 2 });

		await store.removeClient("tab-b");
		expect(await store.get("room1", "cursor")).toEqual({});
		expect(await store.size()).toBe(0);
	});

	test("expired entries are hidden on read and swept on cleanup", async () => {
		const store = adapter();

		await store.set("room1", "cursor", "c1", "u1", { x: 1 }, 20);
		await store.set("room1", "cursor", "c2", "u2", { x: 2 }, 60_000);
		await new Promise((r) => setTimeout(r, 40));

		// Read-time filtering hides it before the sweep runs.
		expect(Object.keys(await store.get("room1", "cursor"))).toEqual(["c2"]);

		await store.cleanupExpired();
		expect(await store.size()).toBe(1);
		expect(Object.keys(await store.get("room1", "cursor"))).toEqual(["c2"]);
	});

	test("publish reaches a subscriber on another connection", async () => {
		const subConnection = connect();
		await subConnection.connect();

		const received: EphemeralBroadcast[] = [];
		const listener = createRedisEphemeral({
			client: callShim(client),
			subscriber: subscriberShim(subConnection),
			prefix,
		});
		await listener.subscribe!((event) => received.push(event));

		const publisher = adapter();
		await publisher.publish!({
			serverId: "server-a",
			key: "cursor",
			clientId: "c1",
			userId: "u1",
			data: { x: 42 },
			targets: [{ query: "posts", room: "org/acme" }],
		});

		// Delivery is asynchronous; poll rather than sleep a fixed budget.
		for (let i = 0; i < 50 && received.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}

		expect(received.length).toBe(1);
		expect(received[0]).toMatchObject({
			serverId: "server-a",
			key: "cursor",
			userId: "u1",
			data: { x: 42 },
		});
		expect(received[0]!.targets).toEqual([{ query: "posts", room: "org/acme" }]);
	});

	test("two adapters on one prefix see the same state", async () => {
		const instanceA = adapter();
		const secondConnection = connect();
		await secondConnection.connect();
		const instanceB = createRedisEphemeral({ client: callShim(secondConnection), prefix });

		await instanceA.set("room1", "cursor", "c1", "u1", { x: 1 });

		// This is the property the in-process store cannot provide: a client
		// arriving on another instance sees who is already there.
		expect((await instanceB.getRoom("room1")).cursor!.c1!.data).toEqual({ x: 1 });
	});
});
