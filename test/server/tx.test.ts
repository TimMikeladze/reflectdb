import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
	__setDrizzleHelpersForTest,
	createServer,
} from "../../src/server/server.ts";
import { createMockTransport } from "./helpers.ts";

// ── Schema ──────────────────────────────────────────────────────────────

const posts = sqliteTable("posts", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
});

const comments = sqliteTable("comments", {
	id: text("id").primaryKey(),
	body: text("body").notNull(),
	count: integer("count").notNull().default(0),
});

function setup() {
	const sqlite = new Database(":memory:");
	sqlite.run(`CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
	sqlite.run(
		`CREATE TABLE comments (id TEXT PRIMARY KEY, body TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)`,
	);
	return drizzle(sqlite);
}

/**
 * Wrap createServer with a notifyChange counter. The counter records the
 * tables passed to handler.notifyChange() so tests can assert call counts and
 * dedup behavior without spinning up a real subscriber.
 */
function makeServer(db: ReturnType<typeof setup>) {
	const transport = createMockTransport();
	const server = createServer({
		db,
		transport,
		serverId: "tx-test",
	});
	const notified: string[] = [];
	const orig = server.notifyChange.bind(server);
	server.notifyChange = async (tableName: string, roomKey?: string | null) => {
		notified.push(tableName);
		await orig(tableName, roomKey);
	};
	return { server, notified };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("server.tx", () => {
	test("single-table write fires exactly one notifyChange", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		await server.tx(async (tx) => {
			await tx.insert(posts).values({ id: "p1", title: "hi" }).run();
		});

		expect(notified).toEqual(["posts"]);
		const rows = await db.select().from(posts).all();
		expect(rows).toHaveLength(1);
		await server.close();
	});

	test("two-table write fires exactly one notifyChange per table", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		await server.tx(async (tx) => {
			await tx.insert(posts).values({ id: "p1", title: "a" }).run();
			await tx.insert(comments).values({ id: "c1", body: "b" }).run();
		});

		expect(notified.sort()).toEqual(["comments", "posts"]);
		await server.close();
	});

	test("same table touched twice deduplicates to one notify", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		await server.tx(async (tx) => {
			await tx.insert(posts).values({ id: "p1", title: "a" }).run();
			await tx.insert(posts).values({ id: "p2", title: "b" }).run();
			await tx.update(posts).set({ title: "c" }).where(eq(posts.id, "p1")).run();
		});

		expect(notified).toEqual(["posts"]);
		await server.close();
	});

	test("atomic: true rolls back on throw and skips notifies", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		await expect(
			server.tx({ atomic: true }, async (tx) => {
				await tx.insert(posts).values({ id: "p1", title: "first" }).run();
				throw new Error("boom");
			}),
		).rejects.toThrow(/boom/);

		// Pre-throw insert must not be persisted (rolled back).
		const rows = await db.select().from(posts).all();
		expect(rows).toHaveLength(0);
		// No notifies on throw.
		expect(notified).toEqual([]);
		await server.close();
	});

	test("non-atomic: throw leaves prior writes persisted but skips notifies", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		await expect(
			server.tx({ atomic: false }, async (tx) => {
				await tx.insert(posts).values({ id: "p1", title: "first" }).run();
				throw new Error("boom");
			}),
		).rejects.toThrow(/boom/);

		// Without atomic, the row persisted (no rollback).
		const rows = await db.select().from(posts).all();
		expect(rows).toHaveLength(1);
		// But notifies are still skipped on throw — the spec keeps them all-or-nothing.
		expect(notified).toEqual([]);
		await server.close();
	});

	test("default is atomic — bare tx(fn) rolls back on throw", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		await expect(
			server.tx(async (tx) => {
				await tx.insert(posts).values({ id: "p1", title: "first" }).run();
				throw new Error("boom");
			}),
		).rejects.toThrow(/boom/);

		const rows = await db.select().from(posts).all();
		expect(rows).toHaveLength(0);
		expect(notified).toEqual([]);
		await server.close();
	});

	test("select inside tx does NOT count as a touch", async () => {
		const db = setup();
		await db.insert(posts).values({ id: "seed", title: "x" }).run();
		const { server, notified } = makeServer(db);

		await server.tx(async (tx) => {
			const rows = await tx.select().from(posts).all();
			expect(rows).toHaveLength(1);
		});

		expect(notified).toEqual([]);
		await server.close();
	});

	test("throws when server has no db configured", async () => {
		const transport = createMockTransport();
		const server = createServer({
			transport,
			serverId: "tx-nodb",
		});
		await expect(
			server.tx(async () => {
				/* never called */
			}),
		).rejects.toThrow(/server\.tx requires a db/);
		await server.close();
	});

	test("tx.touch(name) records non-drizzle table name into notifies", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		await server.tx(async (tx) => {
			// Simulate a kysely/prisma/raw-SQL writer that bypasses the proxy
			// intercept. We run a raw insert directly on the underlying db
			// and explicitly notify via tx.touch.
			db.insert(posts).values({ id: "p1", title: "raw" }).run();
			tx.touch("posts");
			tx.touch("audit_log"); // table the proxy could never have detected
		});

		expect(notified.sort()).toEqual(["audit_log", "posts"]);
		await server.close();
	});

	test("tx.touch deduplicates with auto-detected drizzle writes", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		await server.tx(async (tx) => {
			await tx.insert(posts).values({ id: "p1", title: "x" }).run();
			tx.touch("posts"); // duplicate of auto-detected
			tx.touch("comments"); // new
		});

		expect(notified.sort()).toEqual(["comments", "posts"]);
		await server.close();
	});

	test("supports the (opts, fn) overload via positional args", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		await server.tx({}, async (tx) => {
			await tx.insert(posts).values({ id: "p1", title: "x" }).run();
		});

		expect(notified).toEqual(["posts"]);
		await server.close();
	});

	test("atomic: <TxAtomicAdapter> per-call adapter is invoked in begin/commit order", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		const calls: string[] = [];
		const adapter = {
			async begin() {
				calls.push("begin");
			},
			async commit() {
				calls.push("commit");
			},
			async rollback() {
				calls.push("rollback");
			},
		};

		await server.tx({ atomic: adapter }, async (tx) => {
			await tx.insert(posts).values({ id: "p1", title: "x" }).run();
		});

		expect(calls).toEqual(["begin", "commit"]);
		expect(notified).toEqual(["posts"]);
		await server.close();
	});

	test("atomic: <TxAtomicAdapter> rolls back on throw without committing", async () => {
		const db = setup();
		const { server, notified } = makeServer(db);

		const calls: string[] = [];
		const adapter = {
			async begin() {
				calls.push("begin");
			},
			async commit() {
				calls.push("commit");
			},
			async rollback() {
				calls.push("rollback");
			},
		};

		await expect(
			server.tx({ atomic: adapter }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow(/boom/);

		expect(calls).toEqual(["begin", "rollback"]);
		expect(notified).toEqual([]);
		await server.close();
	});

	test("ServerConfig.txAtomic is used as default for atomic: true", async () => {
		const db = setup();
		const transport = createMockTransport();
		const calls: string[] = [];
		const txAtomic = {
			async begin() {
				calls.push("begin");
			},
			async commit() {
				calls.push("commit");
			},
			async rollback() {
				calls.push("rollback");
			},
		};
		const server = createServer({
			db,
			transport,
			serverId: "tx-config-atomic",
			txAtomic,
		});

		await server.tx(async (tx) => {
			await tx.insert(posts).values({ id: "p1", title: "x" }).run();
		});

		expect(calls).toEqual(["begin", "commit"]);
		await server.close();
	});

	test("atomic: true with no drizzle and no txAtomic adapter throws clear error", async () => {
		// Simulate drizzle not being installed at the lazy-import layer.
		__setDrizzleHelpersForTest(null);
		try {
			const db = setup();
			const transport = createMockTransport();
			const server = createServer({
				db,
				transport,
				serverId: "tx-no-drizzle",
			});

			await expect(
				server.tx(async () => {
					/* never reached */
				}),
			).rejects.toThrow(
				/atomic: true.*requires either a drizzle db.*or a `txAtomic` adapter/,
			);

			// `atomic: false` still works without drizzle and without an adapter —
			// auto-detect for table touching is silently skipped, but tx.touch
			// is the explicit escape hatch.
			let ran = false;
			await server.tx({ atomic: false }, async (tx) => {
				tx.touch("posts");
				ran = true;
			});
			expect(ran).toBe(true);

			// Per-call adapter still works when drizzle isn't available.
			const calls: string[] = [];
			await server.tx(
				{
					atomic: {
						async begin() {
							calls.push("begin");
						},
						async commit() {
							calls.push("commit");
						},
						async rollback() {
							calls.push("rollback");
						},
					},
				},
				async () => {
					/* no-op */
				},
			);
			expect(calls).toEqual(["begin", "commit"]);

			await server.close();
		} finally {
			// Reset to natural lazy-load behavior so subsequent tests in the
			// same process aren't affected.
			__setDrizzleHelpersForTest(undefined);
		}
	});

	test("per-call atomic adapter overrides ServerConfig.txAtomic", async () => {
		const db = setup();
		const transport = createMockTransport();
		const configCalls: string[] = [];
		const callCalls: string[] = [];
		const cfgAtomic = {
			async begin() {
				configCalls.push("begin");
			},
			async commit() {
				configCalls.push("commit");
			},
			async rollback() {
				configCalls.push("rollback");
			},
		};
		const callAtomic = {
			async begin() {
				callCalls.push("begin");
			},
			async commit() {
				callCalls.push("commit");
			},
			async rollback() {
				callCalls.push("rollback");
			},
		};
		const server = createServer({
			db,
			transport,
			serverId: "tx-override",
			txAtomic: cfgAtomic,
		});

		await server.tx({ atomic: callAtomic }, async (tx) => {
			await tx.insert(posts).values({ id: "p1", title: "x" }).run();
		});

		expect(configCalls).toEqual([]);
		expect(callCalls).toEqual(["begin", "commit"]);
		await server.close();
	});
});
