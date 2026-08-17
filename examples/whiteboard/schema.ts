import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { defineSyncQueries, t } from "../../src/core/schema.ts";
import { createSqliteStorage } from "../../src/server/storage/sqlite.ts";
import type { ResolvedOp } from "../../src/server/types.ts";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

// ── Drizzle schema ──────────────────────────────────────────────────────

export const games = sqliteTable("games", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	mode: text("mode").notNull().default("freeform"), // "freeform" | "pictionary"
	state: text("state").notNull().default("waiting"), // "waiting" | "drawing" | "round_end" | "finished"
	currentDrawerId: text("current_drawer_id").notNull().default(""),
	currentDrawerName: text("current_drawer_name").notNull().default(""),
	wordMask: text("word_mask").notNull().default(""),
	wordLength: integer("word_length").notNull().default(0),
	roundEndsAt: integer("round_ends_at").notNull().default(0),
	currentRound: integer("current_round").notNull().default(0),
	totalRounds: integer("total_rounds").notNull().default(3),
	playerOrder: text("player_order").notNull().default("[]"),
	scores: text("scores").notNull().default("{}"),
	correctGuessers: text("correct_guessers").notNull().default("[]"),
	roundDurationSec: integer("round_duration_sec").notNull().default(75),
	createdBy: text("created_by").notNull(),
	createdByUserId: text("created_by_user_id").notNull().default(""),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Server-only — never registered with reflectdb, never broadcast.
// Holds the round's secret word + word-pick options, accessible only via
// the drawer-scoped `roundWord` sync query below.
export const gameSecrets = sqliteTable("game_secrets", {
	gameId: text("game_id").primaryKey(),
	word: text("word").notNull().default(""),
	options: text("options").notNull().default("[]"),
});

export const players = sqliteTable("players", {
	id: text("id").primaryKey(), // `${gameId}:${userId}`
	gameId: text("game_id").notNull(),
	userId: text("user_id").notNull(),
	name: text("name").notNull(),
	joinedAt: integer("joined_at", { mode: "timestamp" }).notNull(),
});

export const strokes = sqliteTable("strokes", {
	id: text("id").primaryKey(),
	gameId: text("game_id").notNull(),
	round: integer("round").notNull().default(0),
	points: text("points").notNull(),
	color: text("color").notNull().default("#ffffff"),
	width: real("width").notNull().default(3),
	createdBy: text("created_by").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const messages = sqliteTable("messages", {
	id: text("id").primaryKey(),
	gameId: text("game_id").notNull(),
	text: text("text").notNull(),
	kind: text("kind").notNull().default("chat"), // "chat" | "system" | "correct" | "close"
	createdBy: text("created_by").notNull(),
	createdByUserId: text("created_by_user_id").notNull().default(""),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// ── Typed sync schema ───────────────────────────────────────────────────

export type RoundWord = {
	id: string;
	gameId: string;
	word: string;
	options: string; // JSON-encoded string[]
};

export const queries = defineSyncQueries({
	games: {
		table: games,
		conflict: "lww",
		readonly: [
			"createdBy",
			"createdByUserId",
			"mode",
			"totalRounds",
			"roundDurationSec",
			"state",
			"currentDrawerId",
			"currentDrawerName",
			"wordMask",
			"wordLength",
			"roundEndsAt",
			"currentRound",
			"playerOrder",
			"scores",
			"correctGuessers",
		],
		serverSet: ["createdAt"],
	},
	players: {
		table: players,
		conflict: "lww",
		params: {} as { gameId: string },
		readonly: ["gameId", "userId", "name"],
		serverSet: ["joinedAt"],
	},
	strokes: {
		table: strokes,
		conflict: "lww",
		params: {} as { gameId: string },
		readonly: ["gameId", "createdBy", "round"],
		serverSet: ["createdAt"],
	},
	messages: {
		table: messages,
		conflict: "lww",
		params: {} as { gameId: string },
		readonly: ["gameId", "createdBy", "createdByUserId", "kind"],
		serverSet: ["createdAt"],
	},
	// Per-user query: only the current drawer ever receives the word.
	// Backed by `game_secrets` server-side table, refreshed on every
	// games-row change via the `tables` change-detection hint.
	roundWord: {
		row: t<RoundWord>(),
		params: {} as { gameId: string },
		tables: ["games", "game_secrets"],
		conflict: "lww",
	},
});

// ── Database ────────────────────────────────────────────────────────────

export function createDb() {
	const sqlite = new Database("whiteboard.db");
	sqlite.run("PRAGMA journal_mode = WAL");
	sqlite.run(`CREATE TABLE IF NOT EXISTS games (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		mode TEXT NOT NULL DEFAULT 'freeform',
		state TEXT NOT NULL DEFAULT 'waiting',
		current_drawer_id TEXT NOT NULL DEFAULT '',
		current_drawer_name TEXT NOT NULL DEFAULT '',
		word_mask TEXT NOT NULL DEFAULT '',
		word_length INTEGER NOT NULL DEFAULT 0,
		round_ends_at INTEGER NOT NULL DEFAULT 0,
		current_round INTEGER NOT NULL DEFAULT 0,
		total_rounds INTEGER NOT NULL DEFAULT 3,
		player_order TEXT NOT NULL DEFAULT '[]',
		scores TEXT NOT NULL DEFAULT '{}',
		correct_guessers TEXT NOT NULL DEFAULT '[]',
		round_duration_sec INTEGER NOT NULL DEFAULT 75,
		created_by TEXT NOT NULL DEFAULT '',
		created_by_user_id TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL
	)`);
	sqlite.run(`CREATE TABLE IF NOT EXISTS game_secrets (
		game_id TEXT PRIMARY KEY,
		word TEXT NOT NULL DEFAULT '',
		options TEXT NOT NULL DEFAULT '[]'
	)`);
	sqlite.run(`CREATE TABLE IF NOT EXISTS players (
		id TEXT PRIMARY KEY,
		game_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT NOT NULL,
		joined_at INTEGER NOT NULL
	)`);
	sqlite.run(`CREATE TABLE IF NOT EXISTS strokes (
		id TEXT PRIMARY KEY,
		game_id TEXT NOT NULL,
		round INTEGER NOT NULL DEFAULT 0,
		points TEXT NOT NULL,
		color TEXT NOT NULL DEFAULT '#ffffff',
		width REAL NOT NULL DEFAULT 3,
		created_by TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL
	)`);
	sqlite.run(`CREATE TABLE IF NOT EXISTS messages (
		id TEXT PRIMARY KEY,
		game_id TEXT NOT NULL,
		text TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'chat',
		created_by TEXT NOT NULL DEFAULT '',
		created_by_user_id TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL
	)`);

	const db = drizzle(sqlite);
	const storage = createSqliteStorage({ db: sqlite });

	return { db, sqlite, storage };
}

// ── Auth context ────────────────────────────────────────────────────────

export interface AppAuth extends Record<string, unknown> {
	userId: string;
	name: string;
}

// ── Game helpers ────────────────────────────────────────────────────────

export const WORDS = [
	"apple",
	"banana",
	"bicycle",
	"bridge",
	"butterfly",
	"camera",
	"castle",
	"cat",
	"chair",
	"cloud",
	"computer",
	"cookie",
	"crown",
	"dolphin",
	"dragon",
	"elephant",
	"envelope",
	"eyeball",
	"fire",
	"flower",
	"frog",
	"ghost",
	"giraffe",
	"glasses",
	"guitar",
	"hammer",
	"hat",
	"helicopter",
	"hotdog",
	"ice cream",
	"island",
	"jellyfish",
	"key",
	"kite",
	"ladder",
	"lamp",
	"lighthouse",
	"mountain",
	"mushroom",
	"octopus",
	"pencil",
	"piano",
	"pizza",
	"pumpkin",
	"rainbow",
	"robot",
	"rocket",
	"sandwich",
	"shark",
	"snowman",
	"spider",
	"sun",
	"sword",
	"telescope",
	"tiger",
	"tornado",
	"train",
	"tree",
	"umbrella",
	"unicorn",
	"volcano",
	"watermelon",
	"whale",
	"window",
	"witch",
];

export function pickWord(): string {
	return WORDS[Math.floor(Math.random() * WORDS.length)]!;
}

export function pickWordOptions(count = 3): string[] {
	const pool = [...WORDS];
	const out: string[] = [];
	for (let i = 0; i < count && pool.length > 0; i++) {
		const idx = Math.floor(Math.random() * pool.length);
		out.push(pool.splice(idx, 1)[0]!);
	}
	return out;
}

export function maskWord(word: string): string {
	return word
		.split("")
		.map((ch) => (ch === " " ? "  " : "_"))
		.join(" ");
}

// ── Mutate handlers ─────────────────────────────────────────────────────

export async function mutateGame(
	op: ResolvedOp,
	ctx: { auth: AppAuth },
	db: BunSQLiteDatabase,
) {
	if (op.type === "delete") {
		const existing = await db
			.select()
			.from(games)
			.where(eq(games.id, op.rowId))
			.get();
		if (existing && existing.createdByUserId !== ctx.auth.userId) {
			throw new Error("only the room creator can delete it");
		}
		await db.delete(games).where(eq(games.id, op.rowId));
		await db.delete(players).where(eq(players.gameId, op.rowId));
		await db.delete(strokes).where(eq(strokes.gameId, op.rowId));
		await db.delete(messages).where(eq(messages.gameId, op.rowId));
		await db.delete(gameSecrets).where(eq(gameSecrets.gameId, op.rowId));
		return;
	}

	const payload = { ...op.payload } as Record<string, unknown>;
	delete payload.id; // op.rowId is authoritative; ignore any payload.id
	if (op.type === "insert") {
		payload.createdBy = ctx.auth.name;
		payload.createdByUserId = ctx.auth.userId;
	}

	await db
		.insert(games)
		.values({ ...payload, id: op.rowId } as typeof games.$inferInsert)
		.onConflictDoUpdate({ target: games.id, set: payload });
}

export async function mutatePlayer(
	op: ResolvedOp,
	ctx: { auth: AppAuth; params: Record<string, unknown> },
	db: BunSQLiteDatabase,
) {
	// Player row ids are deterministic — `${gameId}:${userId}`. A user can
	// only touch their own row, regardless of op type.
	const expectedId = `${ctx.params.gameId}:${ctx.auth.userId}`;
	if (op.rowId !== expectedId) {
		throw new Error("can only modify your own player row");
	}

	if (op.type === "delete") {
		await db.delete(players).where(eq(players.id, op.rowId));
		return;
	}

	const payload = { ...op.payload } as Record<string, unknown>;
	delete payload.id;
	if (op.type === "insert") {
		if (payload.gameId !== ctx.params.gameId) {
			throw new Error("gameId mismatch");
		}
		payload.userId = ctx.auth.userId;
		payload.name = ctx.auth.name;
	}

	await db
		.insert(players)
		.values({ ...payload, id: op.rowId } as typeof players.$inferInsert)
		.onConflictDoUpdate({ target: players.id, set: payload });
}

export async function mutateStroke(
	op: ResolvedOp,
	ctx: { auth: AppAuth; params: Record<string, unknown> },
	db: BunSQLiteDatabase,
) {
	if (op.type === "delete") {
		await db.delete(strokes).where(eq(strokes.id, op.rowId));
		return;
	}

	const payload = { ...op.payload } as Record<string, unknown>;
	delete payload.id;
	if (op.type === "insert") {
		if (payload.gameId !== ctx.params.gameId) {
			throw new Error("gameId mismatch");
		}
		payload.createdBy = ctx.auth.name;
		const game = await db
			.select()
			.from(games)
			.where(eq(games.id, payload.gameId as string))
			.get();
		if (game?.mode === "pictionary") {
			if (game.state !== "drawing" || game.currentDrawerId !== ctx.auth.userId) {
				throw new Error("not your turn");
			}
			payload.round = game.currentRound;
		}
	}

	await db
		.insert(strokes)
		.values({ ...payload, id: op.rowId } as typeof strokes.$inferInsert)
		.onConflictDoUpdate({ target: strokes.id, set: payload });
}
