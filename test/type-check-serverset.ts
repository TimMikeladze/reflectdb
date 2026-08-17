/**
 * Compile-time type tests for serverSet enforcement.
 * This file should pass `tsc --noEmit`. The @ts-expect-error lines
 * verify that invalid usage IS caught as a type error.
 */
import { defineSyncQueries } from "../src/core/schema.ts";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createSyncServer } from "../src/server/typed-server.ts";

const notes = sqliteTable("notes", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
	createdAt: integer("created_at").notNull(),
});

// ── Schema: valid column in serverSet ────────────────────────────────
const queries = defineSyncQueries({
	notes: { table: notes, serverSet: ["createdAt"] },
});

// ── Schema: invalid column should error ──────────────────────────────
const queriesBad = defineSyncQueries({
	notes: {
		table: notes,
		// @ts-expect-error — "bogus" is not a column on notes
		serverSet: ["bogus"],
	},
});

// ── Implement: correct serverSet ─────────────────────────────────────
declare const transport: import("../src/core/types.ts").ServerTransport;
const server = createSyncServer({ queries, transport });
server.auth(async () => ({ userId: "u1" }));

server.implement("notes", {
	query: (_ctx, _db) => [],
	serverSet: { createdAt: () => new Date() },
});

// ── Implement: missing required key should error ─────────────────────
server.implement("notes", {
	query: (_ctx, _db) => [],
	// @ts-expect-error — missing "createdAt"
	serverSet: {},
});

// ── Implement: extra key should error ────────────────────────────────
server.implement("notes", {
	query: (_ctx, _db) => [],
	// @ts-expect-error — "bogus" not declared in schema serverSet
	serverSet: { createdAt: () => new Date(), bogus: 123 },
});

// ── Implement: missing serverSet entirely should error ───────────────
// @ts-expect-error — serverSet is required when schema declares fields
server.implement("notes", {
	query: (_ctx, _db) => [],
});

// ── No serverSet in schema: should not require it ────────────────────
const queriesNoSS = defineSyncQueries({
	items: { table: notes },
});
const server2 = createSyncServer({ queries: queriesNoSS, transport });
server2.auth(async () => ({ userId: "u1" }));
server2.implement("items", {
	query: (_ctx, _db) => [],
});

// ── Object-form serverSet in schema ─────────────────────────────────
const queriesObj = defineSyncQueries({
	notes: {
		table: notes,
		serverSet: { createdAt: () => new Date() },
	},
});

// Schema object-form rejects unknown columns
const _queriesObjBad = defineSyncQueries({
	notes: {
		table: notes,
		// @ts-expect-error — "bogus" is not a column on notes
		serverSet: { bogus: () => 1 },
	},
});

const server3 = createSyncServer({ queries: queriesObj, transport });
server3.auth(async () => ({ userId: "u1" }));

// Object form: implement.serverSet is OPTIONAL — schema supplies values.
server3.implement("notes", {
	query: (_ctx, _db) => [],
});

// Object form: implement.serverSet may override per-key.
server3.implement("notes", {
	query: (_ctx, _db) => [],
	serverSet: { createdAt: () => new Date(2000) },
});

// Object form: extra (non-schema) keys still rejected.
server3.implement("notes", {
	query: (_ctx, _db) => [],
	// @ts-expect-error — "bogus" not declared in schema serverSet
	serverSet: { bogus: 1 },
});
