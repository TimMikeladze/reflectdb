import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import pg from "pg";
import { createPostgresEphemeral } from "../../src/server/ephemeral/postgres.ts";
import type { EphemeralBroadcast } from "../../src/server/ephemeral/types.ts";

/**
 * Runs against a real Postgres — the capacity gate and LISTEN/NOTIFY are the
 * database's behaviour, which a fake cannot exercise. Skipped, not failed, when
 * no server is reachable:
 *
 *   docker run -d --rm -p 5499:5432 -e POSTGRES_PASSWORD=pg postgres:17-alpine
 *   REFLECTDB_TEST_POSTGRES_URL=postgres://postgres:pg@localhost:5499/postgres bun test
 */
const POSTGRES_URL =
	process.env.REFLECTDB_TEST_POSTGRES_URL ?? "postgres://postgres:pg@localhost:5499/postgres";

async function postgresAvailable(): Promise<boolean> {
	const probe = new pg.Client({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 3000 });
	try {
		await probe.connect();
		await probe.query("SELECT 1");
		return true;
	} catch {
		return false;
	} finally {
		await probe.end().catch(() => {});
	}
}

const available = await postgresAvailable();

/**
 * LISTEN only works on a direct connection; behind a transaction-mode pooler the
 * notification goes to whichever client last held the backend. Probe it, so the
 * notify test skips (and says why) rather than failing against such a server.
 */
async function notifyWorks(): Promise<boolean> {
	if (!available) return false;
	const listen = new pg.Client({ connectionString: POSTGRES_URL });
	const send = new pg.Client({ connectionString: POSTGRES_URL });
	try {
		await listen.connect();
		await send.connect();
		let got = false;
		listen.on("notification", () => {
			got = true;
		});
		await listen.query("LISTEN reflectdb_probe");
		await send.query("NOTIFY reflectdb_probe");
		for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 20));
		return got;
	} catch {
		return false;
	} finally {
		await listen.end().catch(() => {});
		await send.end().catch(() => {});
	}
}
const notify = await notifyWorks();
const testNotify = notify ? test : test.skip;
if (available && !notify) {
	console.warn(
		"[test] LISTEN/NOTIFY does not cross connections here (a pooler?) — skipping the notify test",
	);
}
const describePostgres = available ? describe : describe.skip;

if (!available) {
	console.warn(
		`[test] Postgres unreachable at ${POSTGRES_URL} — skipping Postgres ephemeral suite`,
	);
}

const pool = available ? new pg.Pool({ connectionString: POSTGRES_URL, max: 4 }) : null;
const listenClients: pg.Client[] = [];
const tables: string[] = [];

/** node-postgres LISTEN shim — the wiring the adapter's doc comment shows. */
async function listenerShim() {
	const connection = new pg.Client({ connectionString: POSTGRES_URL });
	await connection.connect();
	listenClients.push(connection);
	return {
		listen: async (channel: string, onPayload: (payload: string) => void) => {
			connection.on("notification", (message) => {
				if (message.channel === channel && message.payload) onPayload(message.payload);
			});
			await connection.query(`LISTEN ${channel}`);
		},
	};
}

afterAll(async () => {
	if (!pool) return;
	for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
	for (const client of listenClients) await client.end().catch(() => {});
	await pool.end();
});

describePostgres("postgres ephemeral adapter", () => {
	let table: string;
	let channel: string;

	beforeEach(() => {
		// Per-test namespace: parallel runs and leftovers from a failed run must
		// not leak into each other's counts or channels.
		const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
		table = `eph_test_${id}`;
		channel = `eph_test_${id}`;
		tables.push(table, `${table}_bus`);
	});

	function adapter(overrides: { maxEntries?: number } = {}) {
		return createPostgresEphemeral({ client: pool!, tablePrefix: table, channel, ...overrides });
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

	test("remove drops the entry", async () => {
		const store = adapter();

		await store.set("room1", "cursor", "c1", "u1", { x: 1 });
		await store.set("room1", "cursor", "c2", "u2", { x: 2 });
		await store.remove("room1", "cursor", "c1");

		expect(Object.keys(await store.get("room1", "cursor"))).toEqual(["c2"]);
		expect(await store.size()).toBe(1);

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

		await store.removeClient("tab-a");
		const remaining = await store.get("room1", "cursor");
		expect(Object.keys(remaining)).toEqual(["tab-b"]);
		expect(remaining["tab-b"]!.data).toEqual({ x: 2 });
	});

	test("expired entries are hidden on read, freed for capacity, and swept on cleanup", async () => {
		const store = adapter({ maxEntries: 2 });

		await store.set("room1", "cursor", "c1", "u1", { x: 1 }, 20);
		await store.set("room1", "cursor", "c2", "u2", { x: 2 }, 60_000);
		await new Promise((r) => setTimeout(r, 40));

		expect(Object.keys(await store.get("room1", "cursor"))).toEqual(["c2"]);
		expect((await store.get("room1", "cursor")).c2!.ttlMs).toBe(60_000);
		// An expired entry no longer counts against the ceiling, swept or not.
		expect(await store.set("room1", "cursor", "c3", "u3", { x: 3 })).toBe(true);

		await store.cleanupExpired();
		const { rows } = await pool!.query(`SELECT client_id FROM ${table} ORDER BY client_id`);
		expect(rows.map((row) => row.client_id)).toEqual(["c2", "c3"]);
	});

	testNotify("publish reaches a listener on another connection", async () => {
		const received: EphemeralBroadcast[] = [];
		const listener = createPostgresEphemeral({
			client: pool!,
			listener: await listenerShim(),
			tablePrefix: table,
			channel,
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

		for (let i = 0; i < 100 && received.length === 0; i++) {
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

	test("polled bus delivers events published after subscribe, in order", async () => {
		const received: EphemeralBroadcast[] = [];
		const event = (x: number): EphemeralBroadcast => ({
			serverId: "server-a",
			key: "cursor",
			clientId: "c1",
			userId: "u1",
			data: { x, blob: "y".repeat(9000) },
			targets: [{ query: "posts", room: "org/acme" }],
		});
		const publisher = createPostgresEphemeral({
			client: pool!,
			tablePrefix: table,
			bus: { poll: 25 },
		});
		// Published before anyone subscribed: a new subscriber starts at the head.
		await publisher.publish!(event(0));

		const listener = createPostgresEphemeral({
			client: pool!,
			tablePrefix: table,
			bus: { poll: 25 },
		});
		await listener.subscribe!((e) => received.push(e));
		await publisher.publish!(event(1));
		await publisher.publish!(event(2));

		for (let i = 0; i < 100 && received.length < 2; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		await listener.destroy();

		// No NOTIFY size cap on the table bus.
		expect(received.map((e) => e.data.x)).toEqual([1, 2]);
		expect(received[0]!.targets).toEqual([{ query: "posts", room: "org/acme" }]);
	});

	test("refuses an event too large for NOTIFY", async () => {
		const publisher = adapter();
		await expect(
			publisher.publish!({
				serverId: "server-a",
				key: "cursor",
				clientId: "c1",
				userId: "u1",
				data: { blob: "x".repeat(9000) },
				targets: [],
			}),
		).rejects.toThrow(/NOTIFY/);
	});

	test("two adapters on one table see the same state", async () => {
		const instanceA = adapter();
		const instanceB = adapter();

		await instanceA.set("room1", "cursor", "c1", "u1", { x: 1 });

		expect((await instanceB.getRoom("room1")).cursor!.c1!.data).toEqual({ x: 1 });
	});

	test("rejects table and channel names it would have to interpolate unsafely", () => {
		expect(() =>
			createPostgresEphemeral({ client: pool!, tablePrefix: "x; DROP TABLE y" }),
		).toThrow();
		expect(() => createPostgresEphemeral({ client: pool!, channel: "a-b" })).toThrow();
	});
});

// Runs without a database: the LISTEN seam and a stub query client are enough.
describe("postgres ephemeral bus startup", () => {
	test("a failed first LISTEN is not cached; the next attempt succeeds", async () => {
		let attempts = 0;
		const adapter = createPostgresEphemeral({
			client: { query: async () => ({ rows: [] }) } as never,
			listener: {
				listen: async () => {
					attempts++;
					if (attempts === 1) throw new Error("connection refused");
				},
			},
		});

		await expect(adapter.ready()).rejects.toThrow("connection refused");
		await adapter.ready();
		expect(attempts).toBe(2);
	});
});
