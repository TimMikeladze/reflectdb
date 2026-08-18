import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TetrisDatabase } from "./database.ts";
import { createPlayer } from "./game.ts";

const temporaryDirectories: string[] = [];

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "reflectdb-tetris-"));
	temporaryDirectories.push(directory);
	return join(directory, "tetris.db");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		// Windows can hold the file for a beat after the last handle closes, so
		// retry rather than fail an otherwise green test on a cleanup race.
		rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

describe("TetrisDatabase", () => {
	test("persists complete runtime state across a database restart", () => {
		const path = databasePath();
		const first = new TetrisDatabase(path);
		const player = createPlayer("p_one", "brisk-otter-01", 1_000, () => 0.42);
		player.board[199] = 7;
		player.score = 1_234;
		player.lines = 9;
		player.deaths = 2;
		player.inputSeq = 14;
		player.processedSeq = 13;
		first.savePlayer(player);
		first.close();

		const second = new TetrisDatabase(path);
		expect(second.getPlayer(player.id)).toEqual(player);
		expect(second.listPlayers()).toEqual([player]);
		second.close();
	});

	test("rolls back game writes when a transaction fails", () => {
		const database = new TetrisDatabase(databasePath());
		const player = createPlayer("p_one", "cosmic-pixel-02", 1_000, () => 0.42);

		expect(() =>
			database.transaction(() => {
				database.savePlayer(player);
				throw new Error("abort tick");
			}),
		).toThrow("abort tick");
		expect(database.getPlayer(player.id)).toBeUndefined();
		database.close();
	});

	test("reaps only stale players with an indexed SQLite delete", () => {
		const database = new TetrisDatabase(databasePath());
		const stale = createPlayer("stale", "quiet-gecko-03", 1_000, () => 0.42);
		const active = createPlayer("active", "rapid-comet-04", 2_000, () => 0.42);
		stale.lastSeen = 100;
		active.lastSeen = 200;
		database.savePlayer(stale);
		database.savePlayer(active);

		expect(database.reapPlayers(150)).toBe(1);
		expect(database.listPlayers().map((player) => player.id)).toEqual(["active"]);
		database.close();
	});

	test("stores reflectdb metadata in the same SQLite file", async () => {
		const path = databasePath();
		const first = new TetrisDatabase(path);
		await first.storage.setMeta("test-key", "durable-value");
		first.close();

		const second = new TetrisDatabase(path);
		await expect(second.storage.getMeta("test-key")).resolves.toBe("durable-value");
		const tables = second.sqlite
			.query<{ name: string }, [string]>(
				"SELECT name FROM sqlite_master WHERE type = ? ORDER BY name",
			)
			.all("table")
			.map((row) => row.name);
		expect(tables).toContain("tetris_players");
		expect(tables).toContain("_reflectdb_oplog");
		second.close();
	});
});
