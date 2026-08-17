import { describe, expect, test } from "bun:test";
import { defineSyncQueries, view } from "../../src/core/schema.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import { createMockTransport } from "./helpers.ts";

describe("server.view", () => {
	test("registers a read-only query and returns rows on declare", async () => {
		const queries = defineSyncQueries({
			roundWord: view({
				row: {} as { id: string; gameId: string; word: string },
				params: {} as { gameId: string },
				deps: ["games", "game_secrets"],
			}),
		});
		const transport = createMockTransport();
		const server = createSyncServer<typeof queries>({
			queries,
			db: {},
			transport,
			serverId: "view-1",
		});

		let invoked = 0;
		server.view("roundWord", (ctx) => {
			invoked++;
			return [{ id: "w1", gameId: ctx.params.gameId, word: "apple" }];
		});

		// notifyChange on a dep table doesn't throw (the view's tables include it).
		await server.notifyChange("games");
		expect(invoked).toBe(0);
		await server.close();
	});

	test("declared deps drive change-detection (notifyChange against a dep is accepted)", async () => {
		const queries = defineSyncQueries({
			roundWord: view({
				row: {} as { id: string; word: string },
				params: {} as { gameId: string },
				deps: ["games"],
			}),
		});
		const transport = createMockTransport();
		const server = createSyncServer<typeof queries>({
			queries,
			db: {},
			transport,
			serverId: "view-2",
		});
		server.view("roundWord", () => [{ id: "w1", word: "apple" }]);

		// No subscribers, so notifyChange is a no-op — but it should resolve cleanly.
		await expect(server.notifyChange("games")).resolves.toBeUndefined();
		await server.close();
	});

	test("calling implement on a view name throws at runtime", async () => {
		const queries = defineSyncQueries({
			roundWord: view({
				row: {} as { id: string; word: string },
				deps: ["games"],
			}),
		});
		const transport = createMockTransport();
		const server = createSyncServer<typeof queries>({
			queries,
			db: {},
			transport,
			serverId: "view-3",
		});

		expect(() =>
			(server.implement as unknown as (name: string, opts: unknown) => void)(
				"roundWord",
				{
					query: () => [],
					mutate: async () => {},
				},
			),
		).toThrow(/server\.view/);
		await server.close();
	});

	test("server.view rejects names not declared as views", async () => {
		const queries = defineSyncQueries({
			posts: {
				row: {} as { id: string; title: string },
				tables: ["posts"],
				conflict: "lww",
			},
		});
		const transport = createMockTransport();
		const server = createSyncServer<typeof queries>({
			queries,
			db: {},
			transport,
			serverId: "view-4",
		});

		expect(() =>
			(server.view as unknown as (name: string, fn: () => unknown) => void)(
				"posts",
				() => [],
			),
		).toThrow(/not declared as a view/);
		await server.close();
	});

	test("view defaults tables to deps; falls back to query name", async () => {
		const queries = defineSyncQueries({
			roundWord: view({
				row: {} as { id: string; word: string },
				// no `deps` -> tables defaults to query key name
			}),
		});
		const transport = createMockTransport();
		const server = createSyncServer<typeof queries>({
			queries,
			db: {},
			transport,
			serverId: "view-5",
		});
		server.view("roundWord", () => [{ id: "w1", word: "apple" }]);

		await expect(server.notifyChange("roundWord")).resolves.toBeUndefined();
		await server.close();
	});
});
