import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_TTL_MS, formatCountdown, roomExpiresAt, timestampToMillis } from "./expiry.ts";
import {
	createDb,
	games,
	gameSecrets,
	messages,
	players,
	strokes,
	sweepExpiredRooms,
} from "./schema.ts";

const temporaryDirectories: string[] = [];

function freshDb() {
	const directory = mkdtempSync(join(tmpdir(), "reflectdb-whiteboard-"));
	temporaryDirectories.push(directory);
	return createDb(join(directory, "whiteboard.db"));
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

const NOW = 1_800_000_000_000;

function seedRoom(db: ReturnType<typeof freshDb>["db"], id: string, createdAtMs: number) {
	db.insert(games)
		.values({ id, name: id, createdBy: "tester", createdAt: new Date(createdAtMs) })
		.run();
	db.insert(players)
		.values({
			id: `${id}:u1`,
			gameId: id,
			userId: "u1",
			name: "Tester",
			joinedAt: new Date(createdAtMs),
		})
		.run();
	db.insert(strokes)
		.values({
			id: `${id}-stroke`,
			gameId: id,
			points: "[]",
			createdBy: "Tester",
			createdAt: new Date(createdAtMs),
		})
		.run();
	db.insert(messages)
		.values({
			id: `${id}-message`,
			gameId: id,
			text: "hi",
			createdBy: "Tester",
			createdAt: new Date(createdAtMs),
		})
		.run();
	db.insert(gameSecrets).values({ gameId: id, word: "banana", options: "[]" }).run();
}

function counts(db: ReturnType<typeof freshDb>["db"]) {
	return {
		games: db.select().from(games).all().length,
		players: db.select().from(players).all().length,
		strokes: db.select().from(strokes).all().length,
		messages: db.select().from(messages).all().length,
		secrets: db.select().from(gameSecrets).all().length,
	};
}

describe("sweepExpiredRooms", () => {
	test("deletes a room past the TTL along with everything in it", () => {
		const { db, sqlite } = freshDb();
		seedRoom(db, "old", NOW - ROOM_TTL_MS - 1000);

		const result = sweepExpiredRooms(db, { now: NOW });

		expect(result.gameIds).toEqual(["old"]);
		expect(result.tables.sort()).toEqual([
			"game_secrets",
			"games",
			"messages",
			"players",
			"strokes",
		]);
		expect(counts(db)).toEqual({
			games: 0,
			players: 0,
			strokes: 0,
			messages: 0,
			secrets: 0,
		});
		sqlite.close();
	});

	test("leaves a room that is still inside its lifetime untouched", () => {
		const { db, sqlite } = freshDb();
		seedRoom(db, "fresh", NOW - ROOM_TTL_MS + 60_000);

		const result = sweepExpiredRooms(db, { now: NOW });

		expect(result.gameIds).toEqual([]);
		expect(result.tables).toEqual([]);
		expect(counts(db)).toEqual({
			games: 1,
			players: 1,
			strokes: 1,
			messages: 1,
			secrets: 1,
		});
		sqlite.close();
	});

	test("sweeps only the expired room when both ages are present", () => {
		const { db, sqlite } = freshDb();
		seedRoom(db, "old", NOW - ROOM_TTL_MS - 1);
		seedRoom(db, "fresh", NOW - 60_000);

		sweepExpiredRooms(db, { now: NOW });

		expect(
			db
				.select()
				.from(games)
				.all()
				.map((g) => g.id),
		).toEqual(["fresh"]);
		expect(
			db
				.select()
				.from(strokes)
				.all()
				.map((s) => s.gameId),
		).toEqual(["fresh"]);
		expect(
			db
				.select()
				.from(messages)
				.all()
				.map((m) => m.gameId),
		).toEqual(["fresh"]);
		sqlite.close();
	});

	test("collects content left behind by a room that is already gone", () => {
		const { db, sqlite } = freshDb();
		seedRoom(db, "gone", NOW - 60_000);
		// Simulate a crash between deleting the room row and its content.
		sqlite.run("DELETE FROM games WHERE id = 'gone'");

		const result = sweepExpiredRooms(db, { now: NOW });

		expect(result.gameIds).toEqual([]);
		expect(result.tables.sort()).toEqual(["game_secrets", "messages", "players", "strokes"]);
		expect(counts(db)).toEqual({
			games: 0,
			players: 0,
			strokes: 0,
			messages: 0,
			secrets: 0,
		});
		sqlite.close();
	});

	test("uses the caller's TTL when one is supplied", () => {
		const { db, sqlite } = freshDb();
		seedRoom(db, "recent", NOW - 5_000);

		expect(sweepExpiredRooms(db, { now: NOW, ttlMs: 60_000 }).gameIds).toEqual([]);
		expect(sweepExpiredRooms(db, { now: NOW, ttlMs: 1_000 }).gameIds).toEqual(["recent"]);
		sqlite.close();
	});
});

describe("expiry helpers", () => {
	test("normalizes every shape a timestamp arrives in", () => {
		const iso = "2027-01-15T12:00:00.000Z";
		const ms = Date.parse(iso);
		expect(timestampToMillis(new Date(ms))).toBe(ms);
		expect(timestampToMillis(iso)).toBe(ms);
		expect(timestampToMillis(ms)).toBe(ms);
		// SQLite stores `mode: "timestamp"` columns in whole seconds.
		expect(timestampToMillis(ms / 1000)).toBe(ms);
		expect(timestampToMillis(undefined)).toBe(0);
		expect(timestampToMillis("")).toBe(0);
	});

	test("expiry is the creation time plus the TTL", () => {
		const created = new Date(NOW);
		expect(roomExpiresAt(created)).toBe(NOW + ROOM_TTL_MS);
		expect(roomExpiresAt(undefined)).toBe(0);
	});

	test("counts down in m:ss and clamps at zero", () => {
		expect(formatCountdown(ROOM_TTL_MS)).toBe("30:00");
		expect(formatCountdown(61_000)).toBe("1:01");
		expect(formatCountdown(-5_000)).toBe("0:00");
	});
});
