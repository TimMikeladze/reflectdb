import { describe, expect, test } from "bun:test";
import {
	advancePlayer,
	applyInput,
	canPlace,
	createClock,
	createPlayer,
	emptyBoard,
	gravityMs,
	LINES_PER_LEVEL,
	levelFor,
	lockPiece,
	publicPlayer,
	randomName,
	reap,
	replayInputs,
	spawnNext,
	SURVIVAL_POINTS_PER_SECOND,
} from "./game.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, PIECE_KINDS, TICK_MS, pieceCells } from "./schema.ts";

const fixedRandom = () => 0.42;

describe("tetromino geometry", () => {
	test("every piece has four unique cells in every rotation", () => {
		for (const kind of PIECE_KINDS) {
			for (let rotation = 0; rotation < 4; rotation++) {
				const cells = pieceCells(kind, rotation);
				expect(cells).toHaveLength(4);
				expect(new Set(cells.map((cell) => `${cell.x},${cell.y}`)).size).toBe(4);
				expect(cells.every((cell) => cell.x >= 0 && cell.y >= 0)).toBe(true);
			}
		}
	});

	test("collision rejects walls, floor, and settled blocks", () => {
		const player = createPlayer("p1", "test", 0, fixedRandom);
		player.piece = "O";
		expect(canPlace(player, "O", 0, 0, 0)).toBe(true);
		expect(canPlace(player, "O", 0, -1, 0)).toBe(false);
		expect(canPlace(player, "O", 0, BOARD_WIDTH - 1, 0)).toBe(false);
		expect(canPlace(player, "O", 0, 0, BOARD_HEIGHT - 1)).toBe(false);
		player.board[0] = 1;
		expect(canPlace(player, "O", 0, 0, 0)).toBe(false);
	});
});

describe("continuous runs", () => {
	test("hard drop settles a piece and immediately queues another", () => {
		const player = createPlayer("p1", "test", 0, fixedRandom);
		player.piece = "I";
		player.next = "O";
		player.x = 3;
		player.y = 0;

		expect(applyInput(player, "hard-drop", fixedRandom)).toBe(true);
		// Dropping is a placement control, not a score: only time and lines pay.
		expect(player.score).toBe(0);
		expect(player.board.slice(-BOARD_WIDTH).filter(Boolean)).toHaveLength(4);
		expect(String(player.piece)).toBe("O");
		expect(player.y).toBe(0);
	});

	test("clearing a line awards points and compacts the well", () => {
		const player = createPlayer("p1", "test", 0, fixedRandom);
		player.board = emptyBoard();
		for (let x = 0; x < BOARD_WIDTH; x++) {
			if (x < 3 || x > 6) player.board[(BOARD_HEIGHT - 1) * BOARD_WIDTH + x] = 2;
		}
		player.piece = "I";
		player.next = "O";
		player.rotation = 0;
		player.x = 3;
		player.y = BOARD_HEIGHT - 1;

		lockPiece(player, fixedRandom);

		expect(player.lines).toBe(1);
		expect(player.score).toBe(100);
		expect(player.board.every((cell) => cell === 0)).toBe(true);
	});

	test("top-out resets score and board, counts a death, and keeps playing", () => {
		const player = createPlayer("p1", "test", 0, fixedRandom);
		player.score = 4_200;
		player.lines = 17;
		player.deaths = 2;
		player.next = "T";
		for (const cell of pieceCells("T", 0, 3, 0)) {
			player.board[cell.y * BOARD_WIDTH + cell.x] = 7;
		}

		expect(spawnNext(player, fixedRandom)).toBe(true);
		expect(player.score).toBe(0);
		expect(player.lines).toBe(0);
		expect(player.deaths).toBe(3);
		expect(player.board).toEqual(emptyBoard());
		expect(canPlace(player, player.piece, player.rotation, player.x, player.y)).toBe(true);
	});

	test("gravity advances the active piece on the server clock", () => {
		const player = createPlayer("p1", "test", 0, fixedRandom);
		const clock = createClock();
		const startY = player.y;
		expect(advancePlayer(player, clock, gravityMs(player.lines) - 1, fixedRandom)).toBe(false);
		expect(player.y).toBe(startY);
		expect(advancePlayer(player, clock, 1, fixedRandom)).toBe(true);
		expect(player.y).toBe(startY + 1);
	});

	test("gravity accumulates across ticks shorter than one fall interval", () => {
		// The server ticks every TICK_MS; a fall interval is many ticks long. A
		// clock that forgot the leftover between ticks never reached the
		// interval at all, and the piece only ever moved when a key was pressed.
		const player = createPlayer("p1", "test", 0, fixedRandom);
		const clock = createClock();
		const ticks = Math.ceil(gravityMs(player.lines) / TICK_MS);

		for (let tick = 0; tick < ticks - 1; tick++) {
			advancePlayer(player, clock, TICK_MS, fixedRandom);
		}
		expect(player.y).toBe(0);

		advancePlayer(player, clock, TICK_MS, fixedRandom);
		expect(player.y).toBe(1);
	});

	test("surviving pays by the second, scaled by level", () => {
		const player = createPlayer("p1", "test", 0, fixedRandom);
		const clock = createClock();

		// Half a second buys nothing; the remainder carries into the next tick.
		advancePlayer(player, clock, 500, fixedRandom);
		expect(player.score).toBe(0);
		advancePlayer(player, clock, 500, fixedRandom);
		expect(player.score).toBe(SURVIVAL_POINTS_PER_SECOND);

		// Same second of survival, deeper into the run, pays more.
		const veteran = createPlayer("p2", "veteran", 0, fixedRandom);
		veteran.lines = LINES_PER_LEVEL * 3;
		advancePlayer(veteran, createClock(), 1_000, fixedRandom);
		expect(veteran.score).toBe(SURVIVAL_POINTS_PER_SECOND * levelFor(veteran.lines));
		expect(veteran.score).toBeGreaterThan(player.score);
	});

	test("a top-out gives up every point the run earned", () => {
		const player = createPlayer("p1", "test", 0, fixedRandom);
		const clock = createClock();
		for (let second = 0; second < 5; second++) {
			advancePlayer(player, clock, 1_000, fixedRandom);
		}
		expect(player.score).toBeGreaterThan(0);

		// Block the square the queued piece spawns into.
		player.next = "T";
		for (const cell of pieceCells("T", 0, 3, 0)) {
			player.board[cell.y * BOARD_WIDTH + cell.x] = 7;
		}
		expect(spawnNext(player, fixedRandom)).toBe(true);
		expect(player.score).toBe(0);
		expect(player.deaths).toBe(1);
	});

	test("difficulty rises independently from each player's cleared lines", () => {
		expect(levelFor(0)).toBe(1);
		expect(levelFor(4)).toBe(1);
		expect(levelFor(5)).toBe(2);
		expect(levelFor(25)).toBe(6);

		const intervals = [0, 5, 10, 20, 40, 80].map(gravityMs);
		for (let index = 1; index < intervals.length; index++) {
			expect(intervals[index]!).toBeLessThan(intervals[index - 1]!);
		}
		expect(gravityMs(0)).toBe(800);
		expect(gravityMs(1_000)).toBe(75);

		const beginner = createPlayer("beginner", "beginner", 0, fixedRandom);
		const advanced = createPlayer("advanced", "advanced", 0, fixedRandom);
		advanced.lines = 20;
		const advancedInterval = gravityMs(advanced.lines);

		expect(advancePlayer(beginner, createClock(), advancedInterval, fixedRandom)).toBe(false);
		expect(advancePlayer(advanced, createClock(), advancedInterval, fixedRandom)).toBe(true);
		expect(beginner.y).toBe(0);
		expect(advanced.y).toBe(1);
	});
});

describe("player lifecycle", () => {
	test("assigns a random, unused name", () => {
		const values = [0, 0, 0, 0, 0, 0.01];
		let index = 0;
		const random = () => values[index++] ?? 0.5;
		const first = randomName([], random);
		index = 0;
		const second = randomName([first], random);
		expect(first).toBe("brisk-badger-00");
		expect(second).not.toBe(first);
	});

	test("reaps players who leave while retaining active players", () => {
		const stale = createPlayer("stale", "stale", 0, fixedRandom);
		const active = createPlayer("active", "active", 20_000, fixedRandom);
		const players = new Map([
			[stale.id, stale],
			[active.id, active],
		]);
		expect(reap(players, 20_001)).toBe(1);
		expect([...players.keys()]).toEqual(["active"]);
	});

	test("public snapshots expose a detached prediction queue but not clock state", () => {
		const player = createPlayer("p1", "test", 0, fixedRandom);
		const snapshot = publicPlayer(player);
		expect("fallElapsedMs" in snapshot).toBe(false);
		player.board[0] = 7;
		player.bag[0] = snapshot.bag[0] === "I" ? "O" : "I";
		expect(snapshot.board[0]).toBe(0);
		expect(snapshot.bag[0]).not.toBe(player.bag[0]);
	});
});

describe("low-latency prediction", () => {
	test("replays every unacknowledged key over the authoritative snapshot", () => {
		const server = createPlayer("p1", "test", 0, fixedRandom);
		server.piece = "T";
		server.x = 3;
		server.processedSeq = 10;
		const predicted = replayInputs(publicPlayer(server), [
			{ seq: 10, action: "left" },
			{ seq: 11, action: "left" },
			{ seq: 12, action: "rotate-cw" },
		]);

		expect(predicted.x).toBe(2);
		expect(predicted.rotation).toBe(1);
		expect(predicted.inputSeq).toBe(12);
		expect(server.x).toBe(3);
	});

	test("predicts a hard drop and next piece from the server queue", () => {
		const server = createPlayer("p1", "test", 0, fixedRandom);
		server.piece = "I";
		server.next = "O";
		server.x = 3;
		server.processedSeq = 2;
		const expectedAfterNext = server.bag[0];
		const predicted = replayInputs(publicPlayer(server), [{ seq: 3, action: "hard-drop" }]);

		expect(predicted.piece).toBe("O");
		expect(predicted.next).toBe(expectedAfterNext);
		expect(predicted.board.slice(-BOARD_WIDTH).filter(Boolean)).toHaveLength(4);
	});
});
