import { describe, test, expect } from "bun:test";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { defineSyncQueries } from "../../src/core/schema.ts";
import type {
	InferRow,
	InferParams,
	InferWritableRow,
	RequiresParams,
} from "../../src/core/schema.ts";

// ── Test schema ─────────────────────────────────────────────────────────

const posts = sqliteTable("posts", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
	body: text("body").notNull(),
	authorId: text("author_id").notNull(),
	orgId: text("org_id").notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

const cells = sqliteTable("cells", {
	id: text("id").primaryKey(),
	color: text("color").notNull(),
	playerId: text("player_id").notNull(),
});

const userSettings = sqliteTable("user_settings", {
	userId: text("user_id").primaryKey(),
	theme: text("theme").notNull(),
	locale: text("locale").notNull(),
});

const queries = defineSyncQueries({
	posts: {
		table: posts,
		params: {} as { orgId: string },
		conflict: "lww",
		readonly: ["authorId"],
		serverSet: ["updatedAt", "createdAt"],
	},
	cells: {
		table: cells,
		conflict: "lww",
	},
	userSettings: {
		table: userSettings,
		pk: "userId",
		conflict: "lww",
	},
});

type Q = typeof queries;

// ── Type assertion helpers ──────────────────────────────────────────────

function assertType<T>(_value: T): void {}

// ── Tests ───────────────────────────────────────────────────────────────

describe("defineSyncQueries type inference", () => {
	test("InferRow extracts full row type", () => {
		type PostRow = InferRow<Q, "posts">;
		const row: PostRow = {
			id: "p-1",
			title: "Hello",
			body: "World",
			authorId: "u-1",
			orgId: "org-1",
			updatedAt: new Date(),
			createdAt: new Date(),
		};
		assertType<PostRow>(row);
		expect(true).toBe(true);
	});

	test("InferParams extracts typed params", () => {
		type PostParams = InferParams<Q, "posts">;
		const params: PostParams = { orgId: "org-1" };
		assertType<{ orgId: string }>(params);
		expect(true).toBe(true);
	});

	test("InferParams is undefined when no params declared", () => {
		type CellParams = InferParams<Q, "cells">;
		assertType<undefined>(undefined as CellParams);
		expect(true).toBe(true);
	});

	test("RequiresParams is true when params declared", () => {
		type PostReq = RequiresParams<Q, "posts">;
		assertType<true>(true as PostReq);
		expect(true).toBe(true);
	});

	test("RequiresParams is false when no params", () => {
		type CellReq = RequiresParams<Q, "cells">;
		assertType<false>(false as CellReq);
		expect(true).toBe(true);
	});

	test("InferWritableRow excludes readonly + serverSet + id", () => {
		type Writable = InferWritableRow<Q, "posts">;

		// Should have only: title, body, orgId
		const payload: Writable = {
			title: "Hello",
			body: "World",
			orgId: "org-1",
		};
		assertType<Writable>(payload);

		// Verify excluded keys are not in the type
		type WritableKeys = keyof Writable;
		assertType<WritableKeys>("title" as WritableKeys);
		assertType<WritableKeys>("body" as WritableKeys);
		assertType<WritableKeys>("orgId" as WritableKeys);

		// id, authorId, updatedAt, createdAt should NOT be assignable to WritableKeys
		type ExcludedKeys = Exclude<keyof InferRow<Q, "posts">, WritableKeys>;
		assertType<ExcludedKeys>("id" as ExcludedKeys);
		assertType<ExcludedKeys>("authorId" as ExcludedKeys);
		assertType<ExcludedKeys>("updatedAt" as ExcludedKeys);
		assertType<ExcludedKeys>("createdAt" as ExcludedKeys);

		expect(true).toBe(true);
	});

	test("InferWritableRow for cells excludes only id", () => {
		type Writable = InferWritableRow<Q, "cells">;

		// Should have: color, playerId
		const payload: Writable = {
			color: "red",
			playerId: "p-1",
		};
		assertType<Writable>(payload);

		type ExcludedKeys = Exclude<keyof InferRow<Q, "cells">, keyof Writable>;
		assertType<ExcludedKeys>("id" as ExcludedKeys);

		expect(true).toBe(true);
	});

	test("InferWritableRow excludes a non-id primary key", () => {
		type Writable = InferWritableRow<Q, "userSettings">;

		// Should have only: theme, locale (not userId)
		const payload: Writable = {
			theme: "dark",
			locale: "en-US",
		};
		assertType<Writable>(payload);

		// userId must be excluded from writable keys
		type ExcludedKeys = Exclude<keyof InferRow<Q, "userSettings">, keyof Writable>;
		assertType<ExcludedKeys>("userId" as ExcludedKeys);

		expect(true).toBe(true);
	});

	test("const T inference — no as const needed on readonly/serverSet arrays", () => {
		const q = defineSyncQueries({
			items: {
				table: posts,
				readonly: ["authorId", "orgId"],
				serverSet: ["updatedAt"],
			},
		});

		type W = InferWritableRow<typeof q, "items">;
		const payload: W = { title: "Hi", body: "World", createdAt: new Date() };
		assertType<W>(payload);

		// Verify the right fields were excluded
		type ExcludedKeys = Exclude<keyof InferRow<typeof q, "items">, keyof W>;
		assertType<ExcludedKeys>("id" as ExcludedKeys);
		assertType<ExcludedKeys>("authorId" as ExcludedKeys);
		assertType<ExcludedKeys>("orgId" as ExcludedKeys);
		assertType<ExcludedKeys>("updatedAt" as ExcludedKeys);

		expect(true).toBe(true);
	});

	test("InferWritableRow strips object-form serverSet keys", () => {
		const q = defineSyncQueries({
			posts: {
				table: posts,
				readonly: ["authorId"],
				serverSet: {
					updatedAt: () => new Date(),
					createdAt: () => new Date(),
				},
			},
		});

		type W = InferWritableRow<typeof q, "posts">;

		// Allowed: title, body, orgId
		const payload: W = { title: "Hi", body: "World", orgId: "org-1" };
		assertType<W>(payload);

		// Excluded: id, authorId, updatedAt, createdAt
		type ExcludedKeys = Exclude<keyof InferRow<typeof q, "posts">, keyof W>;
		assertType<ExcludedKeys>("id" as ExcludedKeys);
		assertType<ExcludedKeys>("authorId" as ExcludedKeys);
		assertType<ExcludedKeys>("updatedAt" as ExcludedKeys);
		assertType<ExcludedKeys>("createdAt" as ExcludedKeys);

		expect(true).toBe(true);
	});

	test("Object-form serverSet rejects unknown column keys", () => {
		// @ts-expect-error — "nonExistent" is not a column on posts
		defineSyncQueries({
			posts: {
				table: posts,
				serverSet: { nonExistent: () => 1 },
			},
		});

		expect(true).toBe(true);
	});
});
