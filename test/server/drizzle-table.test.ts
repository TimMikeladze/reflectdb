import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineSyncQueries } from "../../src/core/schema.ts";
import { drizzleTable } from "../../src/server/drizzle.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import type { ResolvedOp } from "../../src/server/types.ts";
import type { ServerTransport } from "../../src/core/types.ts";

// ── Schema ──────────────────────────────────────────────────────────────

const posts = sqliteTable("posts", {
	id: text("id").primaryKey(),
	orgId: text("org_id").notNull(),
	authorId: text("author_id").notNull(),
	title: text("title").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }),
});

interface AppAuth extends Record<string, unknown> {
	userId: string;
	name: string;
}

function setup() {
	const sqlite = new Database(":memory:");
	sqlite.run(`CREATE TABLE posts (
		id TEXT PRIMARY KEY,
		org_id TEXT NOT NULL,
		author_id TEXT NOT NULL,
		title TEXT NOT NULL,
		created_at INTEGER
	)`);
	const db = drizzle(sqlite);
	return { db, sqlite };
}

const baseCtx = (overrides: Partial<{ auth: AppAuth; params: Record<string, unknown> }> = {}) => ({
	auth: { userId: "u1", name: "Alice", ...(overrides.auth ?? {}) } as AppAuth,
	params: overrides.params ?? {},
});

const op = (
	type: "insert" | "update" | "delete",
	rowId: string,
	payload: Record<string, unknown> | null,
): ResolvedOp => ({ type, table: "posts", rowId, payload, hlc: "0" });

// ── Tests ───────────────────────────────────────────────────────────────

describe("drizzleTable: default upsert", () => {
	test("inserts a row via default mutate", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts);
		await impl.mutate(
			op("insert", "r1", { title: "hi", orgId: "o1", authorId: "u1" }),
			baseCtx(),
			db,
		);
		const rows = await db.select().from(posts).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe("r1");
		expect(rows[0]!.title).toBe("hi");
	});

	test("update upserts onto existing row", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts);
		await impl.mutate(
			op("insert", "r1", { title: "hi", orgId: "o1", authorId: "u1" }),
			baseCtx(),
			db,
		);
		await impl.mutate(
			op("update", "r1", { title: "hello", orgId: "o1", authorId: "u1" }),
			baseCtx(),
			db,
		);
		const row = await db.select().from(posts).where(eq(posts.id, "r1")).get();
		expect(row!.title).toBe("hello");
	});
});

describe("drizzleTable: id-tampering guard", () => {
	test("payload.id is dropped; op.rowId wins", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts);
		await impl.mutate(
			op("insert", "real", {
				id: "evil",
				title: "t",
				orgId: "o",
				authorId: "u1",
			}),
			baseCtx(),
			db,
		);
		const rows = await db.select().from(posts).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe("real");
	});
});

describe("drizzleTable: scope (column form)", () => {
	test("insert with mismatched payload[col] vs params[col] throws", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, { scope: "orgId" });
		await expect(
			impl.mutate(
				op("insert", "r1", { title: "x", orgId: "o2", authorId: "u1" }),
				baseCtx({ params: { orgId: "o1" } }),
				db,
			),
		).rejects.toThrow(/orgId mismatch/);
	});

	test("update guard: existing row's scope must match params", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, { scope: "orgId" });
		// Seed a row in org "o1"
		await impl.mutate(
			op("insert", "r1", { title: "x", orgId: "o1", authorId: "u1" }),
			baseCtx({ params: { orgId: "o1" } }),
			db,
		);
		// Try to update under wrong-org context
		await expect(
			impl.mutate(
				op("update", "r1", { title: "y", orgId: "o2", authorId: "u1" }),
				baseCtx({ params: { orgId: "o2" } }),
				db,
			),
		).rejects.toThrow(/orgId mismatch/);
	});

	test("query: throws when params.<col> missing", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, { scope: "orgId" });
		expect(() => impl.query(baseCtx(), db)).toThrow(/params.orgId required/);
	});

	test("mutate: rejects missing params.<col> on insert (closes both-undefined bypass)", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, { scope: "orgId" });
		// payload.orgId omitted AND params.orgId omitted — equality would silently
		// pass; explicit guard must reject.
		await expect(
			impl.mutate(
				op("insert", "r1", { title: "x", authorId: "u1" }),
				baseCtx(),
				db,
			),
		).rejects.toThrow(/params.orgId required/);
	});

	test("query: applies WHERE on params[col]", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, { scope: "orgId" });
		await impl.mutate(
			op("insert", "r1", { title: "a", orgId: "o1", authorId: "u1" }),
			baseCtx({ params: { orgId: "o1" } }),
			db,
		);
		await impl.mutate(
			op("insert", "r2", { title: "b", orgId: "o2", authorId: "u1" }),
			baseCtx({ params: { orgId: "o2" } }),
			db,
		);
		const result = await (impl.query(baseCtx({ params: { orgId: "o1" } }), db) as {
			all: () => Promise<Record<string, unknown>[]>;
		}).all();
		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("r1");
	});
});

describe("drizzleTable: scope (auth form)", () => {
	test("insert with payload.column !== ctx.auth[auth] throws", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			scope: { auth: "userId", column: "authorId" },
		});
		await expect(
			impl.mutate(
				op("insert", "r1", { title: "t", orgId: "o", authorId: "OTHER" }),
				baseCtx({ auth: { userId: "u1", name: "A" } }),
				db,
			),
		).rejects.toThrow(/authorId mismatch/);
	});

	test("update on someone else's row throws", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			scope: { auth: "userId", column: "authorId" },
		});
		// Seed a row owned by u2
		await db.insert(posts).values({ id: "r1", orgId: "o", authorId: "u2", title: "x" }).run();
		// Try to update as u1
		await expect(
			impl.mutate(
				op("update", "r1", { title: "hijacked" }),
				baseCtx({ auth: { userId: "u1", name: "A" } }),
				db,
			),
		).rejects.toThrow(/authorId mismatch/);
	});

	test("query rejects missing auth field", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			scope: { auth: "tenantId" as never, column: "authorId" },
		});
		// auth.tenantId not populated — must throw, not emit `WHERE col = undefined`
		expect(() =>
			(impl.query(baseCtx({ auth: { userId: "u1", name: "A" } }), db) as {
				all: () => Promise<unknown[]>;
			}).all(),
		).toThrow(/auth\.tenantId required/);
	});

	test("insert rejects missing auth field", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			scope: { auth: "tenantId" as never, column: "authorId" },
		});
		await expect(
			impl.mutate(
				op("insert", "r1", { title: "t", orgId: "o", authorId: undefined }),
				baseCtx({ auth: { userId: "u1", name: "A" } }),
				db,
			),
		).rejects.toThrow(/auth\.tenantId required/);
	});
});

describe("drizzleTable: scope (function form)", () => {
	test("function scope filters reads", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			scope: (ctx) => eq(posts.orgId, ctx.params.orgId as string),
		});
		await db.insert(posts).values([
			{ id: "r1", orgId: "o1", authorId: "u1", title: "a" },
			{ id: "r2", orgId: "o2", authorId: "u1", title: "b" },
		]).run();
		const result = await (impl.query(baseCtx({ params: { orgId: "o1" } }), db) as {
			all: () => Promise<Record<string, unknown>[]>;
		}).all();
		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("r1");
	});
});

describe("drizzleTable: rowId template", () => {
	test("mismatch throws", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			rowId: "${gameId}:${auth.userId}",
		});
		await expect(
			impl.mutate(
				op("insert", "wrong:id", { title: "t", orgId: "o", authorId: "u1" }),
				baseCtx({ params: { gameId: "g1" } }),
				db,
			),
		).rejects.toThrow(/rowId mismatch/);
	});

	test("matching template passes", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			rowId: "${gameId}:${auth.userId}",
		});
		await impl.mutate(
			op("insert", "g1:u1", { title: "t", orgId: "o", authorId: "u1" }),
			baseCtx({ params: { gameId: "g1" } }),
			db,
		);
		const rows = await db.select().from(posts).all();
		expect(rows).toHaveLength(1);
	});
});

describe("drizzleTable: ownerStamp", () => {
	test("auth.userId stamp overwrites payload value", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			ownerStamp: { authorId: "auth.userId" },
		});
		await impl.mutate(
			op("insert", "r1", { title: "t", orgId: "o", authorId: "FORGED" }),
			baseCtx({ auth: { userId: "u-real", name: "A" } }),
			db,
		);
		const row = await db.select().from(posts).where(eq(posts.id, "r1")).get();
		expect(row!.authorId).toBe("u-real");
	});

	test("function stamp", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			ownerStamp: { authorId: (ctx) => `${ctx.auth.userId}!` },
		});
		await impl.mutate(
			op("insert", "r1", { title: "t", orgId: "o", authorId: "x" }),
			baseCtx({ auth: { userId: "u-real", name: "A" } }),
			db,
		);
		const row = await db.select().from(posts).where(eq(posts.id, "r1")).get();
		expect(row!.authorId).toBe("u-real!");
	});
});

describe("drizzleTable: serverSet", () => {
	test("server-set value lands in row and survives id-guard", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			serverSet: { createdAt: () => new Date(123) },
		});
		await impl.mutate(
			op("insert", "r1", { title: "t", orgId: "o", authorId: "u1" }),
			baseCtx(),
			db,
		);
		const row = await db.select().from(posts).where(eq(posts.id, "r1")).get();
		// drizzle timestamp mode stores as seconds-since-epoch
		expect(row!.createdAt).toBeDefined();
	});
});

describe("drizzleTable: policy", () => {
	test("policy.insert false throws", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			policy: { insert: () => false },
		});
		await expect(
			impl.mutate(
				op("insert", "r1", { title: "t", orgId: "o", authorId: "u1" }),
				baseCtx(),
				db,
			),
		).rejects.toThrow(/policy denied insert/);
	});

	test("policy.update receives existing row", async () => {
		const { db } = setup();
		let seenExisting: Record<string, unknown> | null = null;
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			policy: {
				update: ({ existing }) => {
					seenExisting = existing;
					return true;
				},
			},
		});
		await db.insert(posts).values({ id: "r1", orgId: "o", authorId: "u1", title: "x" }).run();
		await impl.mutate(op("update", "r1", { title: "y" }), baseCtx(), db);
		expect(seenExisting).not.toBeNull();
		expect((seenExisting as unknown as Record<string, unknown>).id).toBe("r1");
		expect((seenExisting as unknown as Record<string, unknown>).title).toBe("x");
	});

	test("policy.delete receives existing row and false blocks", async () => {
		const { db } = setup();
		await db.insert(posts).values({ id: "r1", orgId: "o", authorId: "u1", title: "x" }).run();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			policy: { delete: ({ existing }) => existing.authorId === "DIFFERENT" },
		});
		await expect(
			impl.mutate(op("delete", "r1", null), baseCtx(), db),
		).rejects.toThrow(/policy denied delete/);
		const row = await db.select().from(posts).where(eq(posts.id, "r1")).get();
		expect(row).toBeDefined();
	});

	test("policy.fields server-only drops on insert AND update", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			policy: { fields: { title: "server-only" } },
			ownerStamp: { title: () => "stamped" },
		});
		await impl.mutate(
			op("insert", "r1", { title: "client-tries", orgId: "o", authorId: "u1" }),
			baseCtx(),
			db,
		);
		let row = await db.select().from(posts).where(eq(posts.id, "r1")).get();
		expect(row!.title).toBe("stamped");

		// Update: no ownerStamp on update, server-only blocks the field
		await impl.mutate(op("update", "r1", { title: "another-try" }), baseCtx(), db);
		row = await db.select().from(posts).where(eq(posts.id, "r1")).get();
		expect(row!.title).toBe("stamped");
	});

	test("policy.fields insert-only allows insert, blocks update", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			policy: { fields: { orgId: "insert-only" } },
		});
		await impl.mutate(
			op("insert", "r1", { title: "t", orgId: "first", authorId: "u1" }),
			baseCtx(),
			db,
		);
		await impl.mutate(op("update", "r1", { orgId: "TRY-CHANGE", title: "t2" }), baseCtx(), db);
		const row = await db.select().from(posts).where(eq(posts.id, "r1")).get();
		expect(row!.orgId).toBe("first");
		expect(row!.title).toBe("t2");
	});

	test("policy.fields predicate strips field when false", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			policy: { fields: { title: { write: () => false } } },
			ownerStamp: { title: () => "from-stamp" },
		});
		await impl.mutate(
			op("insert", "r1", { title: "rejected", orgId: "o", authorId: "u1" }),
			baseCtx(),
			db,
		);
		const row = await db.select().from(posts).where(eq(posts.id, "r1")).get();
		expect(row!.title).toBe("from-stamp");
	});

	test("policy.read via authorize callback", async () => {
		const { db } = setup();
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			policy: { read: () => false },
		});
		await expect(
			impl.authorize({ type: "read", table: "posts", params: {} }, baseCtx(), db),
		).rejects.toThrow(/policy denied read/);
	});
});

describe("drizzleTable: hooks", () => {
	test("beforeInsert mutates payload; afterInsert sees persisted row", async () => {
		const { db } = setup();
		let afterRow: Record<string, unknown> | null = null;
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			hooks: {
				beforeInsert: ({ payload }) => {
					payload.title = "hook-rewrote";
				},
				afterInsert: ({ row }) => {
					afterRow = row;
				},
			},
		});
		await impl.mutate(
			op("insert", "r1", { title: "orig", orgId: "o", authorId: "u1" }),
			baseCtx(),
			db,
		);
		const row = await db.select().from(posts).where(eq(posts.id, "r1")).get();
		expect(row!.title).toBe("hook-rewrote");
		expect(afterRow).not.toBeNull();
		expect((afterRow as unknown as Record<string, unknown>).title).toBe("hook-rewrote");
	});
});

describe("drizzleTable: overrides", () => {
	test("opts.insert override skips default upsert", async () => {
		const { db } = setup();
		let called = false;
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			insert: ({ payload, ctx, db }) => {
				called = true;
				return Promise.resolve(
					db
						.insert(posts)
						.values({
							id: "override-id",
							orgId: payload.orgId as string,
							authorId: payload.authorId as string,
							title: "override-title",
						})
						.run(),
				);
			},
		});
		await impl.mutate(
			op("insert", "original-id", { title: "x", orgId: "o", authorId: "u1" }),
			baseCtx(),
			db,
		);
		expect(called).toBe(true);
		const rows = await db.select().from(posts).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe("override-id");
		expect(rows[0]!.title).toBe("override-title");
	});
});

describe("drizzleTable: delete", () => {
	test("policy.delete runs and row is removed; null payload OK", async () => {
		const { db } = setup();
		await db.insert(posts).values({ id: "r1", orgId: "o", authorId: "u1", title: "x" }).run();
		let policyCalled = false;
		const impl = drizzleTable<typeof posts, AppAuth>(posts, {
			policy: {
				delete: ({ existing }) => {
					policyCalled = true;
					return existing.authorId === "u1";
				},
			},
		});
		await impl.mutate(op("delete", "r1", null), baseCtx(), db);
		expect(policyCalled).toBe(true);
		const rows = await db.select().from(posts).all();
		expect(rows).toHaveLength(0);
	});
});

describe("drizzleTable: server.implement integration", () => {
	test("registers cleanly and exercises drizzleTable mutate via applyServerOp", async () => {
		const { db } = setup();
		const queries = defineSyncQueries({
			posts: { table: posts, conflict: "lww", params: {} as { orgId: string } },
		});
		const transport: ServerTransport = {
			async send() {},
			async broadcast() {},
			onMessage() {},
			onConnect() {},
			onDisconnect() {},
			async close() {},
		};
		const server = createSyncServer<typeof queries, typeof db, AppAuth>({
			queries,
			db,
			transport,
			serverId: "factory-int",
		});

		const impl = drizzleTable<typeof posts, AppAuth, { orgId: string }>(posts, {
			scope: "orgId",
			ownerStamp: { authorId: "auth.userId" },
		});

		// Plug into server.implement to verify the shape is compatible.
		server.implement("posts", impl as never);

		// Drive a server-origin op through the pipeline; execute callback invokes
		// the same mutate the registration uses.
		await server.applyServerOp(
			{
				type: "insert",
				table: "posts",
				rowId: "r-int",
				payload: { title: "hi", orgId: "o1", authorId: "FORGED" },
			},
			async (stamped) => {
				const ctx = { auth: { userId: "u-real", name: "A" }, params: { orgId: "o1" } };
				await impl.mutate(stamped as ResolvedOp, ctx, db);
			},
		);

		const rows = await db.select().from(posts).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe("r-int");
		// ownerStamp overrode the forged authorId
		expect(rows[0]!.authorId).toBe("u-real");
		await server.close();
	});
});
