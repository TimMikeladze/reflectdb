import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineTable, type TableAdapter } from "../../src/server/factory.ts";
import type { ResolvedOp } from "../../src/server/types.ts";

// ── Schema (raw sqlite — no drizzle) ─────────────────────────────────────

interface PostRow extends Record<string, unknown> {
	id: string;
	orgId: string;
	authorId: string;
	title: string;
	createdAt: number | null;
}

interface AppAuth extends Record<string, unknown> {
	userId: string;
	name: string;
}

function setup() {
	const sqlite = new Database(":memory:");
	sqlite.run(`CREATE TABLE posts (
		id TEXT PRIMARY KEY,
		orgId TEXT NOT NULL,
		authorId TEXT NOT NULL,
		title TEXT NOT NULL,
		createdAt INTEGER
	)`);
	return sqlite;
}

// Hand-written adapter — pure sqlite, no ORM.
function postsAdapter(): TableAdapter<PostRow> {
	const cols = ["orgId", "authorId", "title", "createdAt"] as const;
	return {
		name: "posts",
		pk: "id",
		list({ db, scope }) {
			const sqlite = db as Database;
			if (!scope) {
				return sqlite.query("SELECT * FROM posts").all() as PostRow[];
			}
			return sqlite
				.query(`SELECT * FROM posts WHERE ${scope.column} = ?`)
				.all(scope.value as string) as PostRow[];
		},
		find({ db, rowId }) {
			const sqlite = db as Database;
			return (sqlite
				.query("SELECT * FROM posts WHERE id = ?")
				.get(rowId) ?? null) as PostRow | null;
		},
		insert({ db, rowId, payload }) {
			const sqlite = db as Database;
			const present = cols.filter((c) => c in payload);
			const fields = ["id", ...present];
			const placeholders = fields.map(() => "?").join(", ");
			const values = [
				rowId,
				...present.map((c) => payload[c] as string | number | null),
			];
			const updates = present.map((c) => `${c} = excluded.${c}`).join(", ");
			const sql = `INSERT INTO posts (${fields.join(", ")}) VALUES (${placeholders})${
				present.length ? ` ON CONFLICT(id) DO UPDATE SET ${updates}` : " ON CONFLICT(id) DO NOTHING"
			}`;
			sqlite.run(sql, ...values);
		},
		update({ db, rowId, payload }) {
			const sqlite = db as Database;
			const present = cols.filter((c) => c in payload);
			if (present.length === 0) return;
			const sets = present.map((c) => `${c} = ?`).join(", ");
			sqlite.run(
				`UPDATE posts SET ${sets} WHERE id = ?`,
				...present.map((c) => payload[c] as string | number | null),
				rowId,
			);
		},
		delete({ db, rowId }) {
			const sqlite = db as Database;
			sqlite.run("DELETE FROM posts WHERE id = ?", rowId);
		},
	};
}

const baseCtx = (
	overrides: Partial<{ auth: AppAuth; params: Record<string, unknown> }> = {},
) => ({
	auth: { userId: "u1", name: "Alice", ...(overrides.auth ?? {}) } as AppAuth,
	params: overrides.params ?? {},
});

const op = (
	type: "insert" | "update" | "delete",
	rowId: string,
	payload: Record<string, unknown> | null,
): ResolvedOp => ({ type, table: "posts", rowId, payload, hlc: "0" });

// ── Tests ───────────────────────────────────────────────────────────────

describe("defineTable: default upsert via custom adapter", () => {
	test("insert lands a row", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter());
		await impl.mutate(
			op("insert", "r1", { title: "hi", orgId: "o1", authorId: "u1" }),
			baseCtx(),
			db,
		);
		const rows = db.query("SELECT * FROM posts").all() as PostRow[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe("r1");
		expect(rows[0]!.title).toBe("hi");
	});

	test("retried insert upserts (idempotent)", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter());
		await impl.mutate(
			op("insert", "r1", { title: "first", orgId: "o", authorId: "u1" }),
			baseCtx(),
			db,
		);
		await impl.mutate(
			op("insert", "r1", { title: "second", orgId: "o", authorId: "u1" }),
			baseCtx(),
			db,
		);
		const rows = db.query("SELECT * FROM posts").all() as PostRow[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.title).toBe("second");
	});
});

describe("defineTable: id-tamper guard", () => {
	test("payload.id is dropped; op.rowId wins", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter());
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
		const rows = db.query("SELECT * FROM posts").all() as PostRow[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe("real");
	});
});

describe("defineTable: scope (params form)", () => {
	test("rejects mismatched payload[col] vs params[col] on insert", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			scope: "orgId",
		});
		await expect(
			impl.mutate(
				op("insert", "r1", { title: "x", orgId: "o2", authorId: "u1" }),
				baseCtx({ params: { orgId: "o1" } }),
				db,
			),
		).rejects.toThrow(/orgId mismatch/);
	});

	test("query filters via adapter.list scope filter", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			scope: "orgId",
		});
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
		const rows = (await impl.query(
			baseCtx({ params: { orgId: "o1" } }),
			db,
		)) as PostRow[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe("r1");
	});

	test("query rejects missing params field", () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			scope: "orgId",
		});
		expect(() => impl.query(baseCtx(), db)).toThrow(/params.orgId required/);
	});
});

describe("defineTable: scope (auth form)", () => {
	test("rejects payload[column] !== auth[key] on insert", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
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

	test("query filters by auth value via adapter scope", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			scope: { auth: "userId", column: "authorId" },
		});
		await impl.mutate(
			op("insert", "r1", { title: "a", orgId: "o", authorId: "u1" }),
			baseCtx(),
			db,
		);
		// Seed a foreign row directly so we know scope filters reads.
		db.run(
			`INSERT INTO posts (id, orgId, authorId, title) VALUES ('r2', 'o', 'u2', 'b')`,
		);
		const rows = (await impl.query(baseCtx(), db)) as PostRow[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe("r1");
	});
});

describe("defineTable: function-form scope without opts.query throws helpful error", () => {
	test("guidance error tells user to override query", () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			scope: () => ({} as never), // function-form scope
		});
		expect(() => impl.query(baseCtx(), db)).toThrow(
			/function-form scope requires opts.query override/,
		);
	});
});

describe("defineTable: policy", () => {
	test("policy.insert false throws", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
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

	test("policy.update sees existing row", async () => {
		const db = setup();
		let seen: Record<string, unknown> | null = null;
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			policy: {
				update: ({ existing }) => {
					seen = existing;
					return true;
				},
			},
		});
		db.run(
			`INSERT INTO posts (id, orgId, authorId, title) VALUES ('r1', 'o', 'u1', 'x')`,
		);
		await impl.mutate(op("update", "r1", { title: "y" }), baseCtx(), db);
		expect(seen).not.toBeNull();
		expect((seen as unknown as PostRow).title).toBe("x");
	});

	test("policy.delete blocks; row stays", async () => {
		const db = setup();
		db.run(
			`INSERT INTO posts (id, orgId, authorId, title) VALUES ('r1', 'o', 'u1', 'x')`,
		);
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			policy: { delete: () => false },
		});
		await expect(
			impl.mutate(op("delete", "r1", null), baseCtx(), db),
		).rejects.toThrow(/policy denied delete/);
		const rows = db.query("SELECT * FROM posts").all() as PostRow[];
		expect(rows).toHaveLength(1);
	});

	test("policy.fields server-only drops on insert and update", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			policy: { fields: { title: "server-only" } },
			ownerStamp: { title: () => "stamped" },
		});
		await impl.mutate(
			op("insert", "r1", { title: "client", orgId: "o", authorId: "u1" }),
			baseCtx(),
			db,
		);
		let row = db.query("SELECT * FROM posts WHERE id = ?").get("r1") as PostRow;
		expect(row.title).toBe("stamped");
		await impl.mutate(op("update", "r1", { title: "again" }), baseCtx(), db);
		row = db.query("SELECT * FROM posts WHERE id = ?").get("r1") as PostRow;
		expect(row.title).toBe("stamped");
	});

	test("policy.fields insert-only allows insert, blocks update", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			policy: { fields: { orgId: "insert-only" } },
		});
		await impl.mutate(
			op("insert", "r1", { title: "t", orgId: "first", authorId: "u1" }),
			baseCtx(),
			db,
		);
		await impl.mutate(
			op("update", "r1", { orgId: "TRY-CHANGE", title: "t2" }),
			baseCtx(),
			db,
		);
		const row = db.query("SELECT * FROM posts WHERE id = ?").get("r1") as PostRow;
		expect(row.orgId).toBe("first");
		expect(row.title).toBe("t2");
	});
});

describe("defineTable: ownerStamp + serverSet", () => {
	test("ownerStamp overwrites forged authorId; serverSet stamps createdAt", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			ownerStamp: { authorId: "auth.userId" },
			serverSet: { createdAt: () => 12345 },
		});
		await impl.mutate(
			op("insert", "r1", { title: "t", orgId: "o", authorId: "FORGED" }),
			baseCtx({ auth: { userId: "u-real", name: "A" } }),
			db,
		);
		const row = db.query("SELECT * FROM posts WHERE id = ?").get("r1") as PostRow;
		expect(row.authorId).toBe("u-real");
		expect(row.createdAt).toBe(12345);
	});
});

describe("defineTable: hooks fire in order", () => {
	test("before/after on insert and update", async () => {
		const db = setup();
		const events: string[] = [];
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			hooks: {
				beforeInsert: () => {
					events.push("beforeInsert");
				},
				afterInsert: () => {
					events.push("afterInsert");
				},
				beforeUpdate: () => {
					events.push("beforeUpdate");
				},
				afterUpdate: () => {
					events.push("afterUpdate");
				},
			},
		});
		await impl.mutate(
			op("insert", "r1", { title: "t", orgId: "o", authorId: "u1" }),
			baseCtx(),
			db,
		);
		await impl.mutate(op("update", "r1", { title: "t2" }), baseCtx(), db);
		expect(events).toEqual([
			"beforeInsert",
			"afterInsert",
			"beforeUpdate",
			"afterUpdate",
		]);
	});
});

describe("defineTable: delete path", () => {
	test("removes row via adapter.delete", async () => {
		const db = setup();
		db.run(
			`INSERT INTO posts (id, orgId, authorId, title) VALUES ('r1', 'o', 'u1', 'x')`,
		);
		const impl = defineTable<PostRow, AppAuth>(postsAdapter());
		await impl.mutate(op("delete", "r1", null), baseCtx(), db);
		const rows = db.query("SELECT * FROM posts").all() as PostRow[];
		expect(rows).toHaveLength(0);
	});
});

describe("defineTable: rowId template", () => {
	test("mismatch rejects; match passes", async () => {
		const db = setup();
		const impl = defineTable<PostRow, AppAuth>(postsAdapter(), {
			rowId: "${gameId}:${auth.userId}",
		});
		await expect(
			impl.mutate(
				op("insert", "wrong", { title: "t", orgId: "o", authorId: "u1" }),
				baseCtx({ params: { gameId: "g1" } }),
				db,
			),
		).rejects.toThrow(/rowId mismatch/);
		await impl.mutate(
			op("insert", "g1:u1", { title: "t", orgId: "o", authorId: "u1" }),
			baseCtx({ params: { gameId: "g1" } }),
			db,
		);
		const rows = db.query("SELECT * FROM posts").all() as PostRow[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe("g1:u1");
	});
});
