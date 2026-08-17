import { describe, test, expect } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineSyncQueries, view } from "../../src/core/schema.ts";
import { createSyncReact } from "../../src/react/typed.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import { createMockTransport } from "../server/helpers.ts";

// ── Test schema ─────────────────────────────────────────────────────────

const posts = sqliteTable("posts", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
});

const queries = defineSyncQueries({
	posts: {
		table: posts,
		conflict: "lww",
	},
	roundWord: view({
		row: {} as { id: string; gameId: string; word: string },
		params: {} as { gameId: string },
		deps: ["games", "game_secrets"],
	}),
});

type Q = typeof queries;

// ── Tests ───────────────────────────────────────────────────────────────

describe("view + useSync type narrowing", () => {
	test("useSync over a view-typed query exposes only rows + loading", () => {
		const { useSync } = createSyncReact<Q>();
		const _check = () => {
			// Type-only check — never actually invoked.
			const view = useSync("roundWord", { params: { gameId: "g1" } });
			// rows is typed.
			const _rows: Array<{ id: string; gameId: string; word: string }> = view.rows;
			// loading exists on the view branch.
			const _loading: boolean = view.loading;
			void _rows;
			void _loading;
			// View branch must NOT expose mutators.
			// @ts-expect-error — view useSync has no `insert`
			view.insert;
			// @ts-expect-error — view useSync has no `update`
			view.update;
			// @ts-expect-error — view useSync has no `remove`
			view.remove;
		};
		void _check;
		expect(true).toBe(true);
	});

	test("useSync over a regular query still exposes mutators", () => {
		const { useSync } = createSyncReact<Q>();
		const _check = () => {
			const result = useSync("posts");
			result.rows;
			result.insert;
			result.update;
			result.remove;
			// @ts-expect-error — non-view branch has no `loading`
			result.loading;
		};
		void _check;
		expect(true).toBe(true);
	});

	test("server.view rejects non-view names at the type level", async () => {
		const transport = createMockTransport();
		const server = createSyncServer<typeof queries>({
			queries,
			db: {},
			transport,
			serverId: "v-types",
		});
		// Valid call: "roundWord" is a view.
		server.view("roundWord", () => []);
		// Type-only check — never invoked.
		const _typeCheck = () => {
			// @ts-expect-error — "posts" is a regular query, not a view
			server.view("posts", () => []);
		};
		void _typeCheck;
		await server.close();
	});

	test("server.implement over a view name is `never` (rejected at type level)", async () => {
		const transport = createMockTransport();
		const server = createSyncServer<typeof queries>({
			queries,
			db: {},
			transport,
			serverId: "v-types-2",
		});
		// Type-only check — never invoked.
		const _typeCheck = () => {
			// @ts-expect-error — view names are filtered out of implement's K parameter
			server.implement("roundWord", { query: () => [] });
		};
		void _typeCheck;
		await server.close();
	});
});
