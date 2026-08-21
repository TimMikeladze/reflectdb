import { beforeEach, describe, expect, test } from "bun:test";
import {
	createMemoryStore,
	createPostgresStore,
	type PresenceStore,
	type WriteRequest,
} from "../../services/presence/store.ts";

/**
 * One contract, both implementations.
 *
 * The service's correctness rests on three store behaviours that are easy to
 * get subtly different between an in-memory map and a SQL statement: what
 * counts as expired, when a write is refused for rate, and when it is refused
 * for capacity. Running the same suite against both is the only way the
 * memory store stays a faithful stand-in for the one that ships.
 *
 * The Postgres half runs only when `PRESENCE_TEST_DATABASE_URL` is set, so the
 * default `bun test` needs no database.
 */

const base: Omit<WriteRequest, "clientId" | "channel" | "data"> = {
	projectId: "p1",
	room: "r1",
	ttlMs: 60_000,
	maxEntriesPerRoom: 100,
	minIntervalMs: 0,
};

function contract(name: string, make: () => Promise<PresenceStore>): void {
	describe(name, () => {
		let store: PresenceStore;

		beforeEach(async () => {
			store = await make();
		});

		test("a write is readable in its room, and scoped to its project", async () => {
			expect(await store.write({ ...base, clientId: "a", channel: "cursor", data: { x: 1 } })).toBe(
				"ok",
			);
			await store.write({
				...base,
				projectId: "p2",
				clientId: "b",
				channel: "cursor",
				data: { x: 9 },
			});

			const mine = await store.room("p1", "r1");
			expect(mine).toHaveLength(1);
			expect(mine[0]).toMatchObject({ clientId: "a", channel: "cursor", data: { x: 1 } });
			expect(await store.room("p2", "r1")).toHaveLength(1);
		});

		test("identity round-trips, and its absence stays absent", async () => {
			await store.write({
				...base,
				clientId: "a",
				channel: "cursor",
				data: { x: 1 },
				identity: { name: "Ada" },
			});
			await store.write({ ...base, clientId: "b", channel: "cursor", data: { x: 2 } });

			const room = await store.room("p1", "r1");
			expect(room.find((e) => e.clientId === "a")!.identity).toEqual({ name: "Ada" });
			expect(room.find((e) => e.clientId === "b")!.identity).toBeUndefined();
		});

		test("a second write inside the minimum interval is refused", async () => {
			const request = {
				...base,
				clientId: "a",
				channel: "cursor",
				data: { x: 1 },
				minIntervalMs: 10_000,
			};
			expect(await store.write(request)).toBe("ok");
			expect(await store.write({ ...request, data: { x: 2 } })).toBe("rate_limited");

			// The refusal must leave the earlier value alone rather than
			// half-apply the write.
			expect((await store.room("p1", "r1"))[0]!.data).toEqual({ x: 1 });
		});

		test("a full room refuses a new entry but still accepts an update to an existing one", async () => {
			const capped = { ...base, maxEntriesPerRoom: 1 };
			expect(await store.write({ ...capped, clientId: "a", channel: "cursor", data: {} })).toBe(
				"ok",
			);
			expect(await store.write({ ...capped, clientId: "b", channel: "cursor", data: {} })).toBe(
				"room_full",
			);
			// Otherwise the first client to fill a room would be frozen in place.
			expect(
				await store.write({ ...capped, clientId: "a", channel: "cursor", data: { x: 2 } }),
			).toBe("ok");
		});

		test("an expired entry stops being readable, and sweeps away", async () => {
			await store.write({ ...base, clientId: "a", channel: "cursor", data: {}, ttlMs: 1 });
			await new Promise((resolve) => setTimeout(resolve, 30));

			expect(await store.room("p1", "r1")).toEqual([]);
			expect(await store.countClients("p1")).toBe(0);
			expect(await store.hasClient("p1", "a")).toBe(false);
			expect(await store.sweep()).toBe(1);
		});

		test("remove drops one channel, or every channel a client holds", async () => {
			for (const channel of ["cursor", "here"]) {
				await store.write({ ...base, clientId: "a", channel, data: {} });
			}
			await store.write({ ...base, clientId: "b", channel: "cursor", data: {} });

			await store.remove("p1", "r1", "a", "cursor");
			expect(
				(await store.room("p1", "r1")).map((e) => `${e.clientId}/${e.channel}`).sort(),
			).toEqual(["a/here", "b/cursor"]);

			await store.remove("p1", "r1", "a");
			expect((await store.room("p1", "r1")).map((e) => e.clientId)).toEqual(["b"]);
		});

		test("clients are counted once however many channels they hold", async () => {
			for (const channel of ["cursor", "here", "typing"]) {
				await store.write({ ...base, clientId: "a", channel, data: {} });
			}
			await store.write({ ...base, room: "r2", clientId: "b", channel: "cursor", data: {} });

			expect(await store.countClients("p1")).toBe(2);
			expect(await store.hasClient("p1", "a")).toBe(true);
			expect(await store.hasClient("p1", "nobody")).toBe(false);
		});

		test("updatedAt advances on a write, which is what the poller diffs on", async () => {
			await store.write({ ...base, clientId: "a", channel: "cursor", data: { x: 1 } });
			const first = (await store.room("p1", "r1"))[0]!.updatedAt;
			await new Promise((resolve) => setTimeout(resolve, 5));
			await store.write({ ...base, clientId: "a", channel: "cursor", data: { x: 2 } });

			expect((await store.room("p1", "r1"))[0]!.updatedAt).toBeGreaterThan(first);
		});
	});
}

contract("memory store", async () => createMemoryStore());

const DATABASE_URL = process.env.PRESENCE_TEST_DATABASE_URL;
if (DATABASE_URL) {
	const { default: pg } = await import("pg");
	const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2, ssl: false });
	contract("postgres store", async () => {
		const sql = {
			query: (text: string, values?: unknown[]) =>
				pool.query(text, values as unknown[] | undefined) as Promise<{
					rows: Record<string, unknown>[];
				}>,
		};
		const store = createPostgresStore({ sql });
		// Each case starts from an empty table; the contract asserts on counts.
		await store.room("p1", "r1");
		await pool.query("TRUNCATE presence_entry");
		return store;
	});
}
