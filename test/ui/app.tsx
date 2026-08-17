import {
	SyncProvider,
	useSync,
	useSyncStatus,
	usePendingCount,
	useEphemeral,
	useSyncClient,
} from "../../src/react/index.ts";
import { useState, useEffect, useCallback, useMemo } from "react";

const GRID_SIZE = 20;

// ── Types ────────────────────────────────────────────────────────────────────

interface Cell {
	id: string;
	color: string;
	playerId: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomColor(): string {
	const hue = Math.floor(Math.random() * 360);
	return `hsl(${hue}, 70%, 60%)`;
}

function cellId(row: number, col: number): string {
	return `${row},${col}`;
}

// ── Ephemeral Cursors ────────────────────────────────────────────────────────

function CursorLayer({ playerId, playerColor }: { playerId: string; playerColor: string }) {
	const { events, broadcast } = useEphemeral<{ cell: string; color: string }>({
		key: "hover",
		userId: playerId,
		ttlMs: 3000,
	});

	const handleCellHover = useCallback(
		(id: string) => {
			broadcast({ cell: id, color: playerColor });
		},
		[broadcast, playerColor],
	);

	// Expose hover handler via a custom event on window
	useEffect(() => {
		const handler = (e: CustomEvent) => handleCellHover(e.detail as string);
		window.addEventListener("cell-hover" as string, handler as EventListener);
		return () => window.removeEventListener("cell-hover" as string, handler as EventListener);
	}, [handleCellHover]);

	return events;
}

// ── Status Bar ───────────────────────────────────────────────────────────────

function StatusBar() {
	const status = useSyncStatus();
	const pending = usePendingCount();

	return (
		<div className={`status ${status}`}>
			{status === "synced" ? "Connected" : status}
			{pending > 0 && ` · ${pending} pending`}
		</div>
	);
}

// ── Grid ─────────────────────────────────────────────────────────────────────

function Grid({ playerId, playerColor }: { playerId: string; playerColor: string }) {
	const { rows, insert } = useSync<Cell>("cells");
	const cursorEvents = CursorLayer({ playerId, playerColor });

	const cellMap = useMemo(() => {
		const map = new Map<string, Cell>();
		for (const cell of rows) {
			map.set(cell.id, cell);
		}
		return map;
	}, [rows]);

	const cursorMap = useMemo(() => {
		const map = new Map<string, string>();
		for (const [uid, data] of Object.entries(cursorEvents)) {
			if (uid !== playerId) {
				map.set(data.cell, data.color);
			}
		}
		return map;
	}, [cursorEvents, playerId]);

	const handleClick = useCallback(
		(row: number, col: number) => {
			const id = cellId(row, col);
			if (cellMap.has(id)) return;
			insert(id, { id, color: playerColor, playerId });
		},
		[cellMap, insert, playerColor, playerId],
	);

	const handleHover = useCallback((row: number, col: number) => {
		window.dispatchEvent(new CustomEvent("cell-hover", { detail: cellId(row, col) }));
	}, []);

	const gridCells = useMemo(() => {
		const elements: JSX.Element[] = [];
		for (let r = 0; r < GRID_SIZE; r++) {
			for (let c = 0; c < GRID_SIZE; c++) {
				const id = cellId(r, c);
				const cell = cellMap.get(id);
				const cursor = cursorMap.get(id);

				let bg = "transparent";
				let opacity = 1;
				if (cell) {
					bg = cell.color;
				} else if (cursor) {
					bg = cursor;
					opacity = 0.3;
				}

				elements.push(
					<div
						key={id}
						className={`cell${cell ? " placed" : ""}${!cell ? " empty" : ""}`}
						style={{
							backgroundColor: bg,
							opacity,
						}}
						onClick={() => handleClick(r, c)}
						onMouseEnter={() => handleHover(r, c)}
					/>,
				);
			}
		}
		return elements;
	}, [cellMap, cursorMap, handleClick, handleHover]);

	return (
		<div
			className="grid"
			style={{
				gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)`,
				gridTemplateRows: `repeat(${GRID_SIZE}, 1fr)`,
			}}
		>
			{gridCells}
		</div>
	);
}

// ── Main App ─────────────────────────────────────────────────────────────────

function Game() {
	const { rows } = useSync<Cell>("cells");

	const [playerId] = useState(() => {
		const stored = sessionStorage.getItem("ttt-player-id");
		if (stored) return stored;
		const id = "p-" + Math.random().toString(36).slice(2, 8);
		sessionStorage.setItem("ttt-player-id", id);
		return id;
	});

	const [playerColor] = useState(() => {
		const stored = sessionStorage.getItem("ttt-player-color");
		if (stored) return stored;
		const color = randomColor();
		sessionStorage.setItem("ttt-player-color", color);
		return color;
	});

	const myCells = rows.filter((c) => c.playerId === playerId).length;
	const uniquePlayers = new Set(rows.map((c) => c.player_id)).size;

	return (
		<>
			<header>
				<h1>reflectdb · tic-tac-toe</h1>
				<StatusBar />
			</header>

			<main>
				<Grid playerId={playerId} playerColor={playerColor} />
			</main>

			<footer>
				<div className="footer-left">
					<span className="color-swatch" style={{ backgroundColor: playerColor }} />
					<span>You · {myCells} cells</span>
				</div>
				<div className="footer-center">
					{rows.length} / {GRID_SIZE * GRID_SIZE} placed
					{uniquePlayers > 0 && ` · ${uniquePlayers} player${uniquePlayers !== 1 ? "s" : ""}`}
				</div>
				<div className="footer-right muted">Open in multiple tabs to play together</div>
			</footer>
		</>
	);
}

export function App() {
	return (
		<SyncProvider url="ws://localhost:3001/sync" token="test-token" tables={["cells"]}>
			<Game />
		</SyncProvider>
	);
}

export default App;
