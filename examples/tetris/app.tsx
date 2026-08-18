/** Infinite-player Tetris client. The server owns every board; clients send inputs. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSyncReact } from "../../src/react/index.ts";
import { landingY, levelFor, replayInputs } from "./game.ts";
import type { SequencedInput } from "./game.ts";
import {
	BOARD_HEIGHT,
	BOARD_WIDTH,
	KEEPALIVE_MS,
	colorFor,
	pieceCells,
	pieceValue,
	queries,
} from "./schema.ts";
import type { InputAction, PieceKind, Player } from "./schema.ts";

const { SyncProvider, useSync, useSyncStatus } = createSyncReact(queries);

const KEY_ACTIONS: Readonly<Record<string, InputAction>> = {
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowDown: "soft-drop",
	ArrowUp: "rotate-cw",
	KeyX: "rotate-cw",
	KeyZ: "rotate-ccw",
	Space: "hard-drop",
};
const HELD_REPEAT_MS: Partial<Record<InputAction, number>> = {
	left: 25,
	right: 25,
	"soft-drop": 25,
};
const HORIZONTAL_DAS_MS = 85;

function loadPlayerId(): string {
	const stored = sessionStorage.getItem("tetris.playerId");
	if (stored && /^p_[a-z0-9]{6,32}$/.test(stored)) return stored;
	const id = `p_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
	sessionStorage.setItem("tetris.playerId", id);
	return id;
}

export function App() {
	const [playerId] = useState(loadPlayerId);
	const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sync`;
	return (
		<SyncProvider url={wsUrl} token={playerId} clientId={playerId}>
			<Game playerId={playerId} />
		</SyncProvider>
	);
}

function Game({ playerId }: { playerId: string }) {
	const status = useSyncStatus();
	const { rows: players, insert, update, remove } = useSync("players");
	const { rows: standings } = useSync("standings");
	const me = players.find((player) => player.id === playerId);
	const ready = isReady(me);
	const seqRef = useRef(0);
	const authoritativeRef = useRef<Player | undefined>(undefined);
	const pendingInputsRef = useRef<SequencedInput[]>([]);
	const [predicted, setPredicted] = useState<Player>();

	useEffect(() => {
		if (!isReady(me)) return;
		seqRef.current = Math.max(seqRef.current, me.inputSeq, me.processedSeq);
		pendingInputsRef.current = pendingInputsRef.current.filter(
			(input) => input.seq > me.processedSeq,
		);
		authoritativeRef.current = me;
		const next = replayInputs(me, pendingInputsRef.current);
		setPredicted(next);
	}, [me]);

	useEffect(() => {
		if (status !== "synced" || me) return;
		seqRef.current++;
		insert(playerId, { action: "join", inputSeq: seqRef.current });
	}, [status, me, insert, playerId]);

	const send = useCallback(
		(action: InputAction) => {
			const authoritative = authoritativeRef.current;
			if (!authoritative) return;
			const input = { action, seq: ++seqRef.current };
			pendingInputsRef.current.push(input);
			const next = replayInputs(authoritative, pendingInputsRef.current);
			setPredicted(next);
			update(playerId, { action, inputSeq: input.seq });
		},
		[update, playerId],
	);

	useEffect(() => {
		if (!me) return;
		const timer = setInterval(() => send("heartbeat"), KEEPALIVE_MS);
		return () => clearInterval(timer);
	}, [me, send]);

	useEffect(() => {
		const leave = () => {
			if (me) remove(playerId);
		};
		window.addEventListener("pagehide", leave);
		return () => window.removeEventListener("pagehide", leave);
	}, [me, remove, playerId]);

	useEffect(() => {
		const held = new Map<string, { action: InputAction; nextAt: number; interval: number }>();
		let frame = 0;
		const tick = (now: number) => {
			for (const state of held.values()) {
				let repeats = 0;
				while (now >= state.nextAt && repeats++ < 4) {
					send(state.action);
					state.nextAt += state.interval;
				}
			}
			frame = held.size > 0 ? requestAnimationFrame(tick) : 0;
		};
		const startRepeating = () => {
			if (!frame) frame = requestAnimationFrame(tick);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			const action = KEY_ACTIONS[event.code];
			if (!action) return;
			event.preventDefault();
			if (event.repeat || held.has(event.code)) return;
			send(action);

			const interval = HELD_REPEAT_MS[action];
			if (interval === undefined) return;
			if (action === "left") held.delete("ArrowRight");
			if (action === "right") held.delete("ArrowLeft");
			held.set(event.code, {
				action,
				interval,
				nextAt: performance.now() + (action === "soft-drop" ? interval : HORIZONTAL_DAS_MS),
			});
			startRepeating();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (KEY_ACTIONS[event.code]) event.preventDefault();
			held.delete(event.code);
		};
		const clearHeld = () => held.clear();
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("blur", clearHeld);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", clearHeld);
			if (frame) cancelAnimationFrame(frame);
		};
	}, [send]);

	const displayedMe = ready ? (predicted ?? me) : undefined;

	const others = useMemo(
		() =>
			players
				.filter((player) => player.id !== playerId && isReady(player))
				.sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt),
		[players, playerId],
	);

	return (
		<main className="shell">
			<section className="game-area">
				<div className="game-heading">
					<div>
						<p className="eyebrow">one game · no finish line</p>
						<h1>infinite tetris</h1>
					</div>
					<span className={`status ${status}`}>{status}</span>
				</div>

				<div className="play-layout">
					<div className="well-wrap">
						{displayedMe ? <TetrisBoard player={displayedMe} ghost /> : <EmptyBoard />}
						{!ready && <div className="overlay">joining the stack…</div>}
					</div>

					<div className="run-stats">
						<div className="identity" style={{ borderColor: colorFor(playerId) }}>
							<span>you are</span>
							<strong>{displayedMe ? displayedMe.name : "assigning name…"}</strong>
						</div>
						<Stat label="score" value={displayedMe?.score ?? 0} />
						<Stat label="lines" value={displayedMe?.lines ?? 0} />
						<Stat label="level" value={levelFor(displayedMe?.lines ?? 0)} />
						<Stat label="resets" value={displayedMe?.deaths ?? 0} danger />
						<div className="next-card">
							<span>next</span>
							{displayedMe && <PiecePreview kind={displayedMe.next} />}
						</div>
						<p className="death-note">
							Top out and your score resets to zero. A fresh run starts instantly.
						</p>
					</div>
				</div>

				<Controls send={send} disabled={!ready} />
			</section>

			<aside className="community">
				<div className="crowd-heading">
					<div>
						<h2>live players</h2>
						<p>{players.filter(isReady).length} stacking now</p>
					</div>
					<span className="live-dot" />
				</div>

				<div className="mini-grid">
					{others.slice(0, 8).map((player) => (
						<div className="mini-player" key={player.id}>
							<div className="mini-label">
								<span style={{ color: colorFor(player.id) }}>{player.name}</span>
								<b>{player.score}</b>
							</div>
							<TetrisBoard player={player} mini />
						</div>
					))}
					{others.length === 0 && <p className="nobody">Open another tab to add a player.</p>}
				</div>
				{others.length > 8 && <p className="more">+ {others.length - 8} more live players</p>}

				<h2 className="standings-title">standings</h2>
				<ol className="standings">
					{standings.map((row) => (
						<li key={row.id} className={row.id === playerId ? "self" : undefined}>
							<span className="rank">{row.rank}</span>
							<i style={{ background: colorFor(row.id) }} />
							<span className="who">{row.name}</span>
							<span className="lines">{row.lines}L</span>
							<strong>{row.score}</strong>
						</li>
					))}
				</ol>

				<footer>
					<button type="button" onClick={() => void navigator.clipboard?.writeText(location.href)}>
						copy game link
					</button>
					<p>Everyone who opens this URL joins the same ongoing game with a random name.</p>
				</footer>
			</aside>
		</main>
	);
}

function isReady(player: Player | undefined): player is Player {
	return Boolean(
		player &&
		Array.isArray(player.board) &&
		player.board.length === BOARD_WIDTH * BOARD_HEIGHT &&
		Array.isArray(player.bag) &&
		Number.isSafeInteger(player.processedSeq) &&
		player.piece &&
		player.next,
	);
}

interface RenderCell {
	value: number;
	active?: boolean;
	ghost?: boolean;
}

function renderCells(player: Player, withGhost: boolean): RenderCell[] {
	const cells: RenderCell[] = player.board.map((value) => ({ value }));
	if (withGhost) {
		for (const cell of pieceCells(player.piece, player.rotation, player.x, landingY(player))) {
			if (cell.y >= 0)
				cells[cell.y * BOARD_WIDTH + cell.x] = { value: pieceValue(player.piece), ghost: true };
		}
	}
	for (const cell of pieceCells(player.piece, player.rotation, player.x, player.y)) {
		if (cell.y >= 0)
			cells[cell.y * BOARD_WIDTH + cell.x] = { value: pieceValue(player.piece), active: true };
	}
	return cells;
}

function TetrisBoard({
	player,
	mini = false,
	ghost = false,
}: {
	player: Player;
	mini?: boolean;
	ghost?: boolean;
}) {
	const cells = renderCells(player, ghost);
	return (
		<div
			className={`tetris-board ${mini ? "mini" : ""}`}
			aria-label={`${player.name}'s Tetris board`}
		>
			{cells.map((cell, index) => (
				<span
					key={index}
					className={`cell piece-${cell.value}${cell.active ? " active" : ""}${cell.ghost ? " ghost" : ""}`}
				/>
			))}
		</div>
	);
}

function EmptyBoard() {
	return (
		<div className="tetris-board">
			{Array.from({ length: BOARD_WIDTH * BOARD_HEIGHT }, (_, index) => (
				<span className="cell" key={index} />
			))}
		</div>
	);
}

function PiecePreview({ kind }: { kind: PieceKind }) {
	const occupied = new Set(pieceCells(kind, 0).map((cell) => `${cell.x},${cell.y}`));
	return (
		<div className="piece-preview">
			{Array.from({ length: 16 }, (_, index) => {
				const x = index % 4;
				const y = Math.floor(index / 4);
				return (
					<span
						className={`cell ${occupied.has(`${x},${y}`) ? `piece-${pieceValue(kind)}` : ""}`}
						key={index}
					/>
				);
			})}
		</div>
	);
}

function Stat({
	label,
	value,
	danger = false,
}: {
	label: string;
	value: number;
	danger?: boolean;
}) {
	return (
		<div className={`stat ${danger ? "danger" : ""}`}>
			<span>{label}</span>
			<strong>{value.toLocaleString()}</strong>
		</div>
	);
}

function Controls({ send, disabled }: { send: (action: InputAction) => void; disabled: boolean }) {
	const button = (label: string, action: InputAction, hint: string) => (
		<button
			type="button"
			disabled={disabled}
			onPointerDown={(event) => {
				event.preventDefault();
				send(action);
			}}
			onClick={(event) => {
				// Keyboard-activated buttons have detail=0 and no pointerdown.
				if (event.detail === 0) send(action);
			}}
			aria-label={hint}
			title={hint}
		>
			{label}
		</button>
	);
	return (
		<div className="controls">
			{button("←", "left", "Move left")}
			{button("↺", "rotate-ccw", "Rotate counter-clockwise (Z)")}
			{button("↻", "rotate-cw", "Rotate clockwise (X or up arrow)")}
			{button("→", "right", "Move right")}
			{button("↓", "soft-drop", "Soft drop")}
			{button("drop", "hard-drop", "Hard drop (space)")}
			<p>arrows move · Z/X rotate · space drops</p>
		</div>
	);
}
