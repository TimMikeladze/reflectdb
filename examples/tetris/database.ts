/** Bun SQLite persistence for the perpetual Tetris game. */

import { Database } from "bun:sqlite";
import { createSqliteStorage } from "../../src/server/storage/sqlite.ts";
import type { InputAction, PieceKind, Player } from "./schema.ts";

interface PlayerRow {
	id: string;
	name: string;
	board: string;
	piece: PieceKind;
	next_piece: PieceKind;
	rotation: number;
	x: number;
	y: number;
	score: number;
	lines: number;
	deaths: number;
	action: InputAction;
	input_seq: number;
	processed_seq: number;
	bag: string;
	joined_at: number;
	last_seen: number;
}

function decodePlayer(row: PlayerRow): Player {
	return {
		id: row.id,
		name: row.name,
		board: JSON.parse(row.board) as number[],
		piece: row.piece,
		next: row.next_piece,
		rotation: row.rotation,
		x: row.x,
		y: row.y,
		score: row.score,
		lines: row.lines,
		deaths: row.deaths,
		action: row.action,
		inputSeq: row.input_seq,
		processedSeq: row.processed_seq,
		bag: JSON.parse(row.bag) as PieceKind[],
		joinedAt: row.joined_at,
		lastSeen: row.last_seen,
	};
}

export class TetrisDatabase {
	readonly sqlite: Database;
	readonly storage: ReturnType<typeof createSqliteStorage>;

	private readonly listStatement;
	private readonly getStatement;
	private readonly saveStatement;
	private readonly deleteStatement;
	private readonly reapStatement;

	constructor(path = "tetris.db") {
		this.sqlite = new Database(path, { create: true, strict: true });
		this.sqlite.run("PRAGMA journal_mode = WAL");
		this.sqlite.run("PRAGMA synchronous = NORMAL");
		this.sqlite.run("PRAGMA busy_timeout = 5000");
		this.sqlite.run(`CREATE TABLE IF NOT EXISTS tetris_players (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			board TEXT NOT NULL,
			piece TEXT NOT NULL,
			next_piece TEXT NOT NULL,
			rotation INTEGER NOT NULL,
			x INTEGER NOT NULL,
			y INTEGER NOT NULL,
			score INTEGER NOT NULL,
			lines INTEGER NOT NULL,
			deaths INTEGER NOT NULL,
			action TEXT NOT NULL,
			input_seq INTEGER NOT NULL,
			processed_seq INTEGER NOT NULL,
			bag TEXT NOT NULL,
			joined_at INTEGER NOT NULL,
			last_seen INTEGER NOT NULL
		)`);
		this.sqlite.run(
			"CREATE INDEX IF NOT EXISTS idx_tetris_players_last_seen ON tetris_players (last_seen)",
		);

		this.listStatement = this.sqlite.query<PlayerRow, []>(
			"SELECT * FROM tetris_players ORDER BY joined_at, id",
		);
		this.getStatement = this.sqlite.query<PlayerRow, [string]>(
			"SELECT * FROM tetris_players WHERE id = ?",
		);
		this.saveStatement = this.sqlite.query<
			never,
			[
				string,
				string,
				string,
				string,
				string,
				number,
				number,
				number,
				number,
				number,
				number,
				string,
				number,
				number,
				string,
				number,
				number,
			]
		>(`INSERT INTO tetris_players (
			id, name, board, piece, next_piece, rotation, x, y, score, lines,
			deaths, action, input_seq, processed_seq, bag, joined_at, last_seen
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			board = excluded.board,
			piece = excluded.piece,
			next_piece = excluded.next_piece,
			rotation = excluded.rotation,
			x = excluded.x,
			y = excluded.y,
			score = excluded.score,
			lines = excluded.lines,
			deaths = excluded.deaths,
			action = excluded.action,
			input_seq = excluded.input_seq,
			processed_seq = excluded.processed_seq,
			bag = excluded.bag,
			joined_at = excluded.joined_at,
			last_seen = excluded.last_seen`);
		this.deleteStatement = this.sqlite.query<never, [string]>(
			"DELETE FROM tetris_players WHERE id = ?",
		);
		this.reapStatement = this.sqlite.query<never, [number]>(
			"DELETE FROM tetris_players WHERE last_seen < ?",
		);

		// reflectdb's rows, op log, processed-op ids, HLC, and distributed locks
		// share this same WAL database with the authoritative game table.
		this.storage = createSqliteStorage({ db: this.sqlite });
	}

	listPlayers(): Player[] {
		return this.listStatement.all().map(decodePlayer);
	}

	getPlayer(id: string): Player | undefined {
		const row = this.getStatement.get(id);
		return row ? decodePlayer(row) : undefined;
	}

	savePlayer(player: Player): void {
		this.saveStatement.run(
			player.id,
			player.name,
			JSON.stringify(player.board),
			player.piece,
			player.next,
			player.rotation,
			player.x,
			player.y,
			player.score,
			player.lines,
			player.deaths,
			player.action,
			player.inputSeq,
			player.processedSeq,
			JSON.stringify(player.bag),
			player.joinedAt,
			player.lastSeen,
		);
	}

	deletePlayer(id: string): boolean {
		return this.deleteStatement.run(id).changes > 0;
	}

	reapPlayers(staleBefore: number): number {
		return this.reapStatement.run(staleBefore).changes;
	}

	transaction<T>(callback: () => T): T {
		return this.sqlite.transaction(callback).immediate();
	}

	close(): void {
		// Statements first, then the connection: `sqlite3_close_v2` leaves the file
		// open while any statement is still live, which on Windows keeps the
		// database locked long after `close()` returned. `storage.close()` releases
		// reflectdb's own statements and closes this same shared handle.
		for (const statement of [
			this.listStatement,
			this.getStatement,
			this.saveStatement,
			this.deleteStatement,
			this.reapStatement,
		]) {
			statement.finalize();
		}
		this.storage.close();
	}
}
