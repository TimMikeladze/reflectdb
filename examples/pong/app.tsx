/**
 * Infinite-player pong — client.
 *
 * Paddles are ordinary sync rows: the local one is written at pointer rate and
 * applied optimistically, everyone else's arrives as a delta. Ball state is
 * server-owned and lands 30x a second, so the renderer dead-reckons between
 * frames off the last known position and velocity.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSyncReact } from "../../src/react/index.ts";
import { advancePaddles } from "./interpolate.ts";
import {
	ARENA_R,
	BALL_R,
	KEEPALIVE_MS,
	MAX_NAME_LEN,
	PADDLE_EPSILON,
	PADDLE_SEND_MS,
	PLAYERS_PER_BALL,
	TAU,
	angleDiff,
	buildSectors,
	clampToSector,
	colorFor,
	norm,
	queries,
} from "./schema.ts";
import type { Ball, Player, Sector } from "./schema.ts";

const { SyncProvider, useSync, useSyncStatus, usePresence } = createSyncReact(queries);

const TAUNTS = ["🔥", "😂", "😤", "🫠"];

// ── Identity + arena, both sticky across reloads ────────────────────────

/**
 * Identity is per TAB, not per browser: sessionStorage survives a reload but not
 * a new tab, so opening a second tab genuinely adds a second player to the rim.
 * The display name is a browser-wide preference, so that one stays in
 * localStorage.
 */
function loadPlayerId(): string {
	const stored = sessionStorage.getItem("pong.playerId");
	if (stored && /^p_[a-z0-9]{6,32}$/.test(stored)) return stored;
	const id = `p_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
	sessionStorage.setItem("pong.playerId", id);
	return id;
}

function loadName(id: string): string {
	return localStorage.getItem("pong.name") ?? `guest-${id.slice(2, 6)}`;
}

function loadGameId(): string {
	const raw = new URLSearchParams(location.search).get("game") ?? "main";
	return /^[a-z0-9_-]{1,24}$/i.test(raw) ? raw : "main";
}

// ── Root ────────────────────────────────────────────────────────────────

export function App() {
	const [playerId] = useState(loadPlayerId);
	const gameId = useMemo(loadGameId, []);
	const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sync`;

	return (
		<SyncProvider url={wsUrl} token={playerId} clientId={playerId}>
			<Arena gameId={gameId} playerId={playerId} />
		</SyncProvider>
	);
}

// ── Arena ───────────────────────────────────────────────────────────────

function Arena({ gameId, playerId }: { gameId: string; playerId: string }) {
	const status = useSyncStatus();
	const { rows: players, insert, update } = useSync("players", { params: { gameId } });
	const { rows: balls } = useSync("balls", { params: { gameId } });
	const { rows: standings } = useSync("standings", { params: { gameId } });
	const { peers, set: sendTaunt } = usePresence("taunts", { gameId });

	const [name, setName] = useState(() => loadName(playerId));
	const me = players.find((p) => p.id === playerId);
	const joined = me !== undefined;

	const sectors = useMemo(() => buildSectors(players), [players]);
	const mySector = sectors.find((s) => s.id === playerId);

	// ── Join, then keep the row warm ────────────────────────────────────
	// Every write refreshes `lastSeen` server-side, so an idle tab drops out of
	// the rim on its own after IDLE_TIMEOUT_MS.

	const angleRef = useRef(0);

	useEffect(() => {
		if (status !== "synced" || joined) return;
		insert(playerId, { name, angle: angleRef.current });
	}, [status, joined, insert, playerId, name]);

	useEffect(() => {
		if (!joined) return;
		const timer = setInterval(() => update(playerId, { angle: angleRef.current }), KEEPALIVE_MS);
		return () => clearInterval(timer);
	}, [joined, update, playerId]);

	// A reload keeps your identity (sessionStorage), so the server still holds
	// the paddle where you left it. Adopt that angle instead of snapping to 0
	// and waiting for the first pointer move.
	const seededRef = useRef(false);
	useEffect(() => {
		if (seededRef.current || !me) return;
		seededRef.current = true;
		angleRef.current = me.angle;
	}, [me]);

	// ── Paddle input ────────────────────────────────────────────────────

	const sectorRef = useRef<Sector | undefined>(undefined);
	sectorRef.current = mySector;
	const lastSentRef = useRef(0);
	const lastSentAngleRef = useRef(Number.NaN);

	const aimAt = useCallback(
		(clientX: number, clientY: number, rect: DOMRect) => {
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const raw = norm(Math.atan2(clientY - cy, clientX - cx));
			const sector = sectorRef.current;
			const target = sector ? clampToSector(sector, raw) : raw;
			angleRef.current = target;

			// Your own paddle is drawn from `angleRef` every frame, so this send is
			// purely for everyone else. Cap the rate, and skip moves too small to
			// see — a still pointer should cost nothing.
			const now = performance.now();
			if (now - lastSentRef.current < PADDLE_SEND_MS) return;
			if (Math.abs(angleDiff(target, lastSentAngleRef.current)) < PADDLE_EPSILON) return;
			lastSentRef.current = now;
			lastSentAngleRef.current = target;
			update(playerId, { angle: target });
		},
		[update, playerId],
	);

	const onPointer = useCallback(
		(e: React.PointerEvent<HTMLCanvasElement>) => {
			aimAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
		},
		[aimAt],
	);

	// ── Taunts (ephemeral: never persisted, expires on its own) ─────────

	const [ownTaunt, setOwnTaunt] = useState<{ emoji: string; at: number } | null>(null);

	const taunt = useCallback(
		(emoji: string) => {
			const payload = { emoji, at: Date.now() };
			setOwnTaunt(payload);
			void sendTaunt(payload);
		},
		[sendTaunt],
	);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const index = Number(e.key) - 1;
			if (index >= 0 && index < TAUNTS.length) taunt(TAUNTS[index]!);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [taunt]);

	const tauntsByPlayer = useMemo(() => {
		const map = new Map<string, { emoji: string; at: number }>();
		for (const peer of peers) map.set(peer.userId, peer.state);
		if (ownTaunt) map.set(playerId, ownTaunt);
		return map;
	}, [peers, ownTaunt, playerId]);

	// ── Render loop ─────────────────────────────────────────────────────

	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const viewRef = useRef({
		players: [] as Player[],
		sectors: [] as Sector[],
		taunts: new Map<string, { emoji: string; at: number }>(),
	});
	viewRef.current = { players, sectors, taunts: tauntsByPlayer };

	// Ball snapshots + the moment each arrived, for dead reckoning.
	const ballViewRef = useRef(new Map<string, Ball & { at: number }>());
	useEffect(() => {
		const now = performance.now();
		const next = new Map<string, Ball & { at: number }>();
		for (const b of balls) {
			const prev = ballViewRef.current.get(b.id);
			const same = prev && prev.x === b.x && prev.y === b.y && prev.vx === b.vx && prev.vy === b.vy;
			next.set(b.id, same ? prev : { ...b, at: now });
		}
		ballViewRef.current = next;
	}, [balls]);

	// Render angle per paddle, eased toward the last angle each peer sent.
	const smoothRef = useRef(new Map<string, number>());
	const lastFrameRef = useRef(0);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		let raf = 0;
		lastFrameRef.current = performance.now();
		const draw = () => {
			raf = requestAnimationFrame(draw);
			const now = performance.now();
			const dt = Math.min((now - lastFrameRef.current) / 1000, 0.1);
			lastFrameRef.current = now;

			advancePaddles(viewRef.current.players, smoothRef.current, playerId, angleRef.current, dt);
			paint(ctx, canvas, viewRef.current, ballViewRef.current, smoothRef.current, playerId);
		};
		raf = requestAnimationFrame(draw);

		const resize = () => {
			const rect = canvas.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			canvas.width = Math.max(1, Math.round(rect.width * dpr));
			canvas.height = Math.max(1, Math.round(rect.height * dpr));
		};
		resize();
		const observer = new ResizeObserver(resize);
		observer.observe(canvas);

		return () => {
			cancelAnimationFrame(raf);
			observer.disconnect();
		};
	}, [playerId]);

	// ── UI ──────────────────────────────────────────────────────────────

	const commitName = useCallback(
		(value: string) => {
			const clean = value.slice(0, MAX_NAME_LEN);
			setName(clean);
			localStorage.setItem("pong.name", clean);
			if (joined) update(playerId, { name: clean });
		},
		[joined, update, playerId],
	);

	return (
		<div className="shell">
			<div className="stage">
				<canvas
					ref={canvasRef}
					onPointerMove={onPointer}
					onPointerDown={onPointer}
					className="arena"
				/>
				{status !== "synced" && <div className="overlay">{status}…</div>}
				{status === "synced" && players.length === 0 && (
					<div className="overlay">taking the rim…</div>
				)}
			</div>

			<aside className="panel">
				<header>
					<h1>infinite pong</h1>
					<span className={`status ${status}`}>{status}</span>
				</header>

				<p className="blurb">
					Every player owns one arc of the rim. The circle re-partitions the moment somebody joins
					or leaves — and a ball is added for every {PLAYERS_PER_BALL} players.
				</p>

				<div className="stat-row">
					<div className="stat">
						<span>{players.length}</span>
						<label>in the arena</label>
					</div>
					<div className="stat">
						<span>{balls.length}</span>
						<label>balls</label>
					</div>
					<div className="stat">
						<span style={{ color: colorFor(playerId) }}>{me?.score ?? 0}</span>
						<label>your saves</label>
					</div>
					<div className="stat">
						<span className="miss">{me?.misses ?? 0}</span>
						<label>misses</label>
					</div>
				</div>

				<label className="field">
					<span>name</span>
					<input
						value={name}
						maxLength={MAX_NAME_LEN}
						onChange={(e) => commitName(e.target.value)}
					/>
				</label>

				<div className="taunts">
					{TAUNTS.map((emoji, i) => (
						<button key={emoji} type="button" onClick={() => taunt(emoji)}>
							{emoji}
							<kbd>{i + 1}</kbd>
						</button>
					))}
				</div>

				<h2>standings</h2>
				<ol className="board">
					{standings.map((row) => (
						<li key={row.id} className={row.id === playerId ? "self" : undefined}>
							<i style={{ background: colorFor(row.id) }} />
							<span className="who">{row.name}</span>
							<span className="pts">{row.score}</span>
							<span className="miss">{row.misses}</span>
						</li>
					))}
					{standings.length === 0 && <li className="empty">nobody yet</li>}
				</ol>

				<footer>
					<div className="arena-id">
						arena <code>{gameId}</code>
					</div>
					<button
						type="button"
						onClick={() => {
							void navigator.clipboard?.writeText(location.href);
						}}
					>
						copy invite link
					</button>
					<p className="hint">
						Open this page in another tab (or send the link) to add a player. Add
						<code>?game=other</code> for a separate arena.
					</p>
				</footer>
			</aside>
		</div>
	);
}

// ── Canvas painting ─────────────────────────────────────────────────────

interface ViewState {
	players: Player[];
	sectors: Sector[];
	taunts: Map<string, { emoji: string; at: number }>;
}

/** Never extrapolate further than this past the last server frame. */
const MAX_EXTRAPOLATION_S = 0.25;

function paint(
	ctx: CanvasRenderingContext2D,
	canvas: HTMLCanvasElement,
	view: ViewState,
	ballView: Map<string, Ball & { at: number }>,
	angles: Map<string, number>,
	playerId: string,
): void {
	const w = canvas.width;
	const h = canvas.height;
	const cx = w / 2;
	const cy = h / 2;
	const R = Math.min(w, h) * 0.42;
	const now = performance.now();

	ctx.clearRect(0, 0, w, h);

	// Rim
	ctx.lineWidth = Math.max(1, R * 0.006);
	ctx.strokeStyle = "#1d1d22";
	ctx.beginPath();
	ctx.arc(cx, cy, R, 0, TAU);
	ctx.stroke();

	const byId = new Map(view.players.map((p) => [p.id, p]));

	// Sector dividers + paddles
	for (const sector of view.sectors) {
		const player = byId.get(sector.id);
		if (!player) continue;

		ctx.strokeStyle = "#141418";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(cx + Math.cos(sector.start) * R * 0.12, cy + Math.sin(sector.start) * R * 0.12);
		ctx.lineTo(cx + Math.cos(sector.start) * R, cy + Math.sin(sector.start) * R);
		ctx.stroke();

		const centre = clampToSector(sector, angles.get(player.id) ?? player.angle);
		const isSelf = player.id === playerId;
		const color = colorFor(player.id);

		ctx.strokeStyle = color;
		ctx.lineCap = "round";
		ctx.lineWidth = R * (isSelf ? 0.05 : 0.035);
		ctx.globalAlpha = isSelf ? 1 : 0.75;
		if (isSelf) {
			ctx.shadowColor = color;
			ctx.shadowBlur = R * 0.08;
		}
		ctx.beginPath();
		ctx.arc(cx, cy, R * 0.97, centre - sector.half, centre + sector.half);
		ctx.stroke();
		ctx.shadowBlur = 0;
		ctx.globalAlpha = 1;

		// Name tag, pushed outside the rim
		const lx = cx + Math.cos(centre) * R * 1.09;
		const ly = cy + Math.sin(centre) * R * 1.09;
		ctx.fillStyle = isSelf ? color : "#6b6b74";
		ctx.font = `${Math.round(R * 0.05)}px ui-monospace, monospace`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(player.name, lx, ly);

		const taunt = view.taunts.get(player.id);
		if (taunt) {
			const age = (Date.now() - taunt.at) / 1000;
			if (age < 2) {
				ctx.globalAlpha = Math.max(0, 1 - age / 2);
				ctx.font = `${Math.round(R * 0.11)}px system-ui, sans-serif`;
				ctx.fillText(taunt.emoji, lx, ly - R * 0.12 - age * R * 0.06);
				ctx.globalAlpha = 1;
			}
		}
	}

	// Balls — extrapolated from the last server frame
	for (const b of ballView.values()) {
		const dt = Math.min((now - b.at) / 1000, MAX_EXTRAPOLATION_S);
		let x = b.x + b.vx * dt;
		let y = b.y + b.vy * dt;
		const r = Math.hypot(x, y);
		const limit = ARENA_R - BALL_R;
		if (r > limit) {
			x = (x / r) * limit;
			y = (y / r) * limit;
		}

		const px = cx + x * R;
		const py = cy + y * R;
		const pr = BALL_R * R;

		ctx.fillStyle = "#f5f5f7";
		ctx.shadowColor = "#7df9a3";
		ctx.shadowBlur = pr * 2.2;
		ctx.beginPath();
		ctx.arc(px, py, pr, 0, TAU);
		ctx.fill();
		ctx.shadowBlur = 0;
	}

	// Centre mark
	ctx.strokeStyle = "#1a1a1f";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.arc(cx, cy, R * 0.05, 0, TAU);
	ctx.stroke();
}
