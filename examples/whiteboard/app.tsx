import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { createAuthClient } from "better-auth/react";
import { anonymousClient } from "better-auth/client/plugins";
import {
	SyncProvider,
	useSync,
	useSyncStatus,
	useEphemeral,
} from "../../src/react/index.ts";

// Everything is served by the same Bun process, so the API and the sync socket
// live on whatever origin loaded the page: localhost in development, the Fly
// hostname (over TLS) in production.
const AUTH_URL = window.location.origin;
const SYNC_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/sync`;

const authClient = createAuthClient({
	baseURL: AUTH_URL,
	plugins: [anonymousClient()],
});

// ── Types ───────────────────────────────────────────────────────────────

interface Point {
	x: number;
	y: number;
}

type GameState = "waiting" | "picking" | "drawing" | "round_end" | "finished";

type Game = {
	id: string;
	name: string;
	mode: "freeform" | "pictionary";
	state: GameState;
	currentDrawerId: string;
	currentDrawerName: string;
	wordMask: string;
	wordLength: number;
	roundEndsAt: number;
	currentRound: number;
	totalRounds: number;
	playerOrder: string;
	scores: string;
	correctGuessers: string;
	roundDurationSec: number;
	createdBy: string;
	createdByUserId: string;
	createdAt: number;
} & Record<string, unknown>;

type RoundWord = {
	id: string;
	gameId: string;
	word: string;
	options: string; // JSON-encoded string[]
} & Record<string, unknown>;

type Player = {
	id: string;
	gameId: string;
	userId: string;
	name: string;
	joinedAt: number;
} & Record<string, unknown>;

type Stroke = {
	id: string;
	gameId: string;
	round: number;
	points: string;
	color: string;
	width: number;
	createdBy: string;
	createdAt: number;
} & Record<string, unknown>;

type Message = {
	id: string;
	gameId: string;
	text: string;
	kind: "chat" | "system" | "correct" | "close";
	createdBy: string;
	createdByUserId: string;
	createdAt: number;
} & Record<string, unknown>;

interface ScoreEntry {
	name: string;
	score: number;
}

const COLORS = [
	"#ffffff",
	"#ef4444",
	"#f97316",
	"#eab308",
	"#22c55e",
	"#3b82f6",
	"#a855f7",
	"#ec4899",
];

const SIZES = [2, 4, 8, 14];
const DOT_SPACING = 24;
const DOT_RADIUS = 1;

function safeJson<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

// ── Drawing helpers ─────────────────────────────────────────────────────

function drawDotPattern(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	panX: number,
	panY: number,
) {
	ctx.fillStyle = "#252525";
	const offsetX = ((panX % DOT_SPACING) + DOT_SPACING) % DOT_SPACING;
	const offsetY = ((panY % DOT_SPACING) + DOT_SPACING) % DOT_SPACING;
	for (let x = offsetX; x < w; x += DOT_SPACING) {
		for (let y = offsetY; y < h; y += DOT_SPACING) {
			ctx.beginPath();
			ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
			ctx.fill();
		}
	}
}

function drawWorldStroke(
	ctx: CanvasRenderingContext2D,
	points: Point[],
	color: string,
	width: number,
	panX: number,
	panY: number,
) {
	if (points.length < 2) return;
	ctx.beginPath();
	ctx.strokeStyle = color;
	ctx.lineWidth = width;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.moveTo(points[0]!.x + panX, points[0]!.y + panY);
	for (let i = 1; i < points.length; i++) {
		ctx.lineTo(points[i]!.x + panX, points[i]!.y + panY);
	}
	ctx.stroke();
}

function screenToWorld(
	clientX: number,
	clientY: number,
	canvas: HTMLCanvasElement,
	panX: number,
	panY: number,
): Point {
	const rect = canvas.getBoundingClientRect();
	return {
		x: clientX - rect.left - panX,
		y: clientY - rect.top - panY,
	};
}

// ── Auth Form ───────────────────────────────────────────────────────────

function AuthForm() {
	const [mode, setMode] = useState<"signin" | "signup">("signin");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		setLoading(true);
		try {
			if (mode === "signup") {
				const { error } = await authClient.signUp.email({ name, email, password });
				if (error) {
					setError(error.message ?? "Sign up failed");
					return;
				}
			} else {
				const { error } = await authClient.signIn.email({ email, password });
				if (error) {
					setError(error.message ?? "Sign in failed");
					return;
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong");
		} finally {
			setLoading(false);
		}
	};

	const handleGuest = async () => {
		setError("");
		setLoading(true);
		try {
			await (
				authClient as unknown as { signIn: { anonymous: () => Promise<unknown> } }
			).signIn.anonymous();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Guest sign-in failed");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="auth-container">
			<h1>reflectdb · whiteboard + pictionary</h1>
			<p className="subtitle">Draw together. Or guess what someone drew.</p>
			<form onSubmit={handleSubmit} className="auth-form">
				{mode === "signup" && (
					<input
						type="text"
						placeholder="Name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
					/>
				)}
				<input
					type="email"
					placeholder="Email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					required
				/>
				<input
					type="password"
					placeholder="Password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					required
					minLength={8}
				/>
				{error && <div className="error">{error}</div>}
				<button type="submit" disabled={loading}>
					{loading ? "..." : mode === "signin" ? "Sign In" : "Sign Up"}
				</button>
			</form>
			<p className="toggle">
				{mode === "signin" ? (
					<>
						No account?{" "}
						<button type="button" className="link" onClick={() => setMode("signup")}>
							Sign up
						</button>
					</>
				) : (
					<>
						Have an account?{" "}
						<button type="button" className="link" onClick={() => setMode("signin")}>
							Sign in
						</button>
					</>
				)}
			</p>
			<div className="guest-divider">
				<span>or</span>
			</div>
			<button type="button" className="guest-btn" onClick={handleGuest} disabled={loading}>
				Continue as Guest
			</button>
		</div>
	);
}

// ── Lobby ───────────────────────────────────────────────────────────────

function Lobby({
	onEnter,
	userId,
}: {
	onEnter: (id: string) => void;
	userId: string;
}) {
	const { rows, insert, remove } = useSync<Game>("games");

	const [name, setName] = useState("");
	const [mode, setMode] = useState<"freeform" | "pictionary">("freeform");

	const sorted = useMemo(
		() => [...rows].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
		[rows],
	);

	const create = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			const id = crypto.randomUUID();
			const trimmed = name.trim() || `Room ${sorted.length + 1}`;
			insert(id, {
				id,
				name: trimmed,
				mode,
				totalRounds: 3,
				roundDurationSec: 75,
			} as never);
			setName("");
			onEnter(id);
		},
		[insert, name, mode, sorted.length, onEnter],
	);

	return (
		<div className="lobby">
			<header className="lobby-header">
				<div>
					<h1>Rooms</h1>
					<p className="subtitle">Pick a room or spin up a new one.</p>
				</div>
				<form className="create-form" onSubmit={create}>
					<input
						type="text"
						placeholder="Room name"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<select
						value={mode}
						onChange={(e) => setMode(e.target.value as "freeform" | "pictionary")}
					>
						<option value="pictionary">Pictionary</option>
						<option value="freeform">Freeform draw</option>
					</select>
					<button type="submit">Create</button>
				</form>
			</header>
			<div className="room-grid">
				{sorted.length === 0 && (
					<div className="empty-rooms">No rooms yet — create the first one above.</div>
				)}
				{sorted.map((g) => (
					<button
						key={g.id}
						type="button"
						className={`room-card ${g.mode}`}
						onClick={() => onEnter(g.id)}
					>
						<div className="room-card-top">
							<span className={`room-mode ${g.mode}`}>
								{g.mode === "pictionary" ? "Pictionary" : "Draw"}
							</span>
							<span className={`room-state state-${g.state}`}>
								{g.state.replace("_", " ")}
							</span>
						</div>
						<div className="room-name">{g.name}</div>
						<div className="room-meta">
							{g.mode === "pictionary"
								? `Round ${g.currentRound || 0}/${g.totalRounds}`
								: "Free draw"}
							{g.createdByUserId === userId && (
								<button
									type="button"
									className="room-delete"
									onClick={(e) => {
										e.stopPropagation();
										if (confirm(`Delete "${g.name}"?`)) remove(g.id);
									}}
								>
									Delete
								</button>
							)}
						</div>
					</button>
				))}
			</div>
		</div>
	);
}

// ── Pictionary HUD ──────────────────────────────────────────────────────

function useCountdown(target: number) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const i = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(i);
	}, []);
	return Math.max(0, Math.ceil((target - now) / 1000));
}

function PictionaryHUD({
	game,
	isDrawer,
	drawerWord,
	drawerOptions,
	onStart,
	onReset,
	onPick,
	canStart,
	winner,
}: {
	game: Game;
	isDrawer: boolean;
	drawerWord: string;
	drawerOptions: string[];
	onStart: () => void;
	onReset: () => void;
	onPick: (word: string) => void;
	canStart: boolean;
	winner: { name: string; score: number } | null;
}) {
	const seconds = useCountdown(game.roundEndsAt);

	const stateLabel =
		game.state === "waiting"
			? "Waiting to start"
			: game.state === "picking"
				? `Round ${game.currentRound}/${game.totalRounds}`
				: game.state === "drawing"
					? `Round ${game.currentRound}/${game.totalRounds}`
					: game.state === "round_end"
						? "Round ended"
						: "Game over";

	return (
		<div className="hud">
			<div className="hud-left">
				<span className={`hud-state state-${game.state}`}>{stateLabel}</span>
				{game.state === "drawing" && (
					<span className="hud-drawer">
						<strong>{game.currentDrawerName}</strong> is drawing
					</span>
				)}
				{game.state === "picking" && !isDrawer && (
					<span className="hud-drawer">
						<strong>{game.currentDrawerName}</strong> is choosing a word...
					</span>
				)}
				{game.state === "finished" && winner && (
					<span className="hud-drawer winner-banner">
						🏆 <strong>{winner.name}</strong> wins with {winner.score} pts
					</span>
				)}
			</div>

			<div className="hud-center">
				{game.state === "picking" && isDrawer && drawerOptions.length > 0 && (
					<div className="pick-row">
						<span className="word-label">Pick a word</span>
						<div className="pick-options">
							{drawerOptions.map((w) => (
								<button
									key={w}
									type="button"
									className="pick-btn"
									onClick={() => onPick(w)}
								>
									{w}
								</button>
							))}
						</div>
					</div>
				)}
				{game.state === "drawing" && (
					<div className="word-display">
						{isDrawer ? (
							<>
								<span className="word-label">Your word</span>
								<span className="word">{drawerWord || "..."}</span>
							</>
						) : (
							<>
								<span className="word-label">Word</span>
								<span className="word mask">{game.wordMask}</span>
								<span className="word-len">{game.wordLength} letters</span>
							</>
						)}
					</div>
				)}
			</div>

			<div className="hud-right">
				{(game.state === "drawing" || game.state === "picking") && (
					<span className={`hud-timer ${seconds <= 10 ? "low" : ""}`}>{seconds}s</span>
				)}
				{game.state === "waiting" && (
					<button
						type="button"
						className="hud-btn primary"
						disabled={!canStart}
						onClick={onStart}
					>
						Start game
					</button>
				)}
				{game.state === "finished" && (
					<button type="button" className="hud-btn primary" onClick={onReset}>
						Play again
					</button>
				)}
			</div>
		</div>
	);
}

// ── Player Sidebar ──────────────────────────────────────────────────────

function PlayerSidebar({
	game,
	players,
	userId,
}: {
	game: Game;
	players: Player[];
	userId: string;
}) {
	const scores = useMemo(
		() => safeJson<Record<string, ScoreEntry>>(game.scores, {}),
		[game.scores],
	);
	const guessers = useMemo(
		() => new Set(safeJson<string[]>(game.correctGuessers, [])),
		[game.correctGuessers],
	);

	const list = useMemo(() => {
		const seen = new Set<string>();
		const merged: Array<{
			userId: string;
			name: string;
			score: number;
			joined: boolean;
		}> = [];
		for (const p of players) {
			if (seen.has(p.userId)) continue;
			seen.add(p.userId);
			merged.push({
				userId: p.userId,
				name: p.name,
				score: scores[p.userId]?.score ?? 0,
				joined: true,
			});
		}
		for (const [uid, entry] of Object.entries(scores)) {
			if (seen.has(uid)) continue;
			seen.add(uid);
			merged.push({ userId: uid, name: entry.name, score: entry.score, joined: false });
		}
		merged.sort((a, b) => b.score - a.score);
		return merged;
	}, [players, scores]);

	return (
		<aside className="sidebar">
			<div className="sidebar-section">
				<h3>Players ({players.length})</h3>
				<ul className="player-list">
					{list.map((p) => {
						const isDrawer = p.userId === game.currentDrawerId;
						const guessed = guessers.has(p.userId);
						return (
							<li
								key={p.userId}
								className={`player ${isDrawer ? "drawer" : ""} ${guessed ? "guessed" : ""} ${p.userId === userId ? "self" : ""}`}
							>
								<span className="player-name">
									{p.name}
									{isDrawer && <span className="badge drawer-badge">drawing</span>}
									{guessed && !isDrawer && <span className="badge guess-badge">✓</span>}
									{p.userId === userId && <span className="badge self-badge">you</span>}
								</span>
								<span className="player-score">{p.score}</span>
							</li>
						);
					})}
				</ul>
			</div>
		</aside>
	);
}

// ── Cursor presence ─────────────────────────────────────────────────────

function useCursors(gameId: string, userId: string) {
	const { events, broadcast } = useEphemeral<{
		x: number;
		y: number;
		color: string;
		name: string;
	}>({
		key: `cursor:${gameId}`,
		userId,
		ttlMs: 5000,
	});
	return { cursors: events, broadcastCursor: broadcast };
}

// ── Canvas ──────────────────────────────────────────────────────────────

function Canvas({
	game,
	canDraw,
	isDrawer,
	userName,
	userId,
}: {
	game: Game;
	canDraw: boolean;
	isDrawer: boolean;
	userName: string;
	userId: string;
}) {
	const { rows, insert } = useSync<Stroke>("strokes", {
		params: { gameId: game.id },
	});

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const pointsRef = useRef<Point[]>([]);
	const drawingRef = useRef(false);
	const panRef = useRef({ x: 0, y: 0 });
	const panningRef = useRef(false);
	const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
	const spaceHeldRef = useRef(false);
	const rafRef = useRef(0);

	const [color, setColor] = useState("#ffffff");
	const [brushSize, setBrushSize] = useState(4);
	const [isPanning, setIsPanning] = useState(false);

	const colorRef = useRef(color);
	colorRef.current = color;
	const brushSizeRef = useRef(brushSize);
	brushSizeRef.current = brushSize;
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const canDrawRef = useRef(canDraw);
	canDrawRef.current = canDraw;

	const { cursors, broadcastCursor } = useCursors(game.id, userId);

	const redraw = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d")!;
		const { x: px, y: py } = panRef.current;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		drawDotPattern(ctx, canvas.width, canvas.height, px, py);
		for (const stroke of rowsRef.current) {
			const pts: Point[] = JSON.parse(stroke.points);
			drawWorldStroke(ctx, pts, stroke.color, stroke.width, px, py);
		}
		if (pointsRef.current.length > 1) {
			drawWorldStroke(
				ctx,
				pointsRef.current,
				colorRef.current,
				brushSizeRef.current,
				px,
				py,
			);
		}
	}, []);

	const requestRedraw = useCallback(() => {
		cancelAnimationFrame(rafRef.current);
		rafRef.current = requestAnimationFrame(redraw);
	}, [redraw]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const resize = () => {
			const rect = canvas.parentElement!.getBoundingClientRect();
			canvas.width = rect.width;
			canvas.height = rect.height;
			redraw();
		};
		resize();
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, [redraw]);

	useEffect(() => {
		redraw();
	}, [rows, redraw]);

	useEffect(() => {
		const el = canvasRef.current?.parentElement;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			panRef.current.x -= e.deltaX;
			panRef.current.y -= e.deltaY;
			requestRedraw();
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [requestRedraw]);

	useEffect(() => {
		const onDown = (e: KeyboardEvent) => {
			if (e.code === "Space" && !e.repeat && !(e.target instanceof HTMLInputElement)) {
				e.preventDefault();
				spaceHeldRef.current = true;
				setIsPanning(true);
			}
		};
		const onUp = (e: KeyboardEvent) => {
			if (e.code === "Space") {
				spaceHeldRef.current = false;
				setIsPanning(false);
			}
		};
		window.addEventListener("keydown", onDown);
		window.addEventListener("keyup", onUp);
		return () => {
			window.removeEventListener("keydown", onDown);
			window.removeEventListener("keyup", onUp);
		};
	}, []);

	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		canvas.setPointerCapture(e.pointerId);
		if (e.button === 1 || spaceHeldRef.current) {
			panningRef.current = true;
			panStartRef.current = {
				x: e.clientX,
				y: e.clientY,
				panX: panRef.current.x,
				panY: panRef.current.y,
			};
			setIsPanning(true);
			return;
		}
		if (!canDrawRef.current) return;
		drawingRef.current = true;
		const pt = screenToWorld(e.clientX, e.clientY, canvas, panRef.current.x, panRef.current.y);
		pointsRef.current = [pt];
	}, []);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent) => {
			const canvas = canvasRef.current;
			if (!canvas) return;
			if (panningRef.current) {
				const dx = e.clientX - panStartRef.current.x;
				const dy = e.clientY - panStartRef.current.y;
				panRef.current.x = panStartRef.current.panX + dx;
				panRef.current.y = panStartRef.current.panY + dy;
				requestRedraw();
				return;
			}
			const pt = screenToWorld(e.clientX, e.clientY, canvas, panRef.current.x, panRef.current.y);
			broadcastCursor({ x: pt.x, y: pt.y, color, name: userName });
			if (!drawingRef.current) return;
			pointsRef.current.push(pt);
			requestRedraw();
		},
		[broadcastCursor, color, userName, requestRedraw],
	);

	const handlePointerUp = useCallback(() => {
		if (panningRef.current) {
			panningRef.current = false;
			if (!spaceHeldRef.current) setIsPanning(false);
			return;
		}
		if (!drawingRef.current) return;
		drawingRef.current = false;
		const pts = pointsRef.current;
		if (pts.length > 1 && canDrawRef.current) {
			const id = crypto.randomUUID();
			insert(id, {
				id,
				gameId: game.id,
				points: JSON.stringify(pts),
				color: colorRef.current,
				width: brushSizeRef.current,
				createdBy: userName,
			} as never);
		}
		pointsRef.current = [];
		requestRedraw();
	}, [insert, game.id, userName, requestRedraw]);

	const cursorEntries = useMemo(
		() =>
			Object.entries(cursors).filter(([uid]) => uid !== userId) as [
				string,
				{ x: number; y: number; color: string; name: string },
			][],
		[cursors, userId],
	);

	return (
		<>
			<div
				className={`canvas-wrap ${isPanning ? "panning" : ""} ${canDraw ? "" : "view-only"}`}
			>
				<canvas
					ref={canvasRef}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerLeave={handlePointerUp}
					onContextMenu={(e) => e.preventDefault()}
				/>
				{cursorEntries.map(([uid, c]) => (
					<div
						key={uid}
						className="presence-cursor"
						style={
							{
								left: c.x + panRef.current.x,
								top: c.y + panRef.current.y,
								"--cursor-color": c.color,
							} as React.CSSProperties
						}
					>
						<svg width="16" height="20" viewBox="0 0 16 20" fill="none">
							<path
								d="M1 1L6 18L8.5 10.5L15 8L1 1Z"
								fill="var(--cursor-color)"
								stroke="#000"
								strokeWidth="1.5"
							/>
						</svg>
						<span className="presence-label" style={{ background: c.color }}>
							{c.name}
						</span>
					</div>
				))}
				{!canDraw && !(game.state === "picking" && isDrawer) && (
					<div className="canvas-overlay-note">
						{game.state === "drawing"
							? "Watching — guess in chat ↓"
							: game.state === "waiting"
								? "Waiting for the game to start"
								: game.state === "finished"
									? "Game over"
									: game.state === "picking"
										? `${game.currentDrawerName} is choosing a word...`
										: "Round ending..."}
					</div>
				)}
			</div>

			<div className={`toolbar ${canDraw ? "" : "disabled"}`}>
				<div className="tool-group">
					{COLORS.map((c) => (
						<button
							key={c}
							type="button"
							className={`color-btn ${c === color ? "active" : ""}`}
							style={{ background: c }}
							disabled={!canDraw}
							onClick={() => setColor(c)}
						/>
					))}
				</div>
				<div className="tool-group">
					{SIZES.map((s) => (
						<button
							key={s}
							type="button"
							className={`size-btn ${s === brushSize ? "active" : ""}`}
							disabled={!canDraw}
							onClick={() => setBrushSize(s)}
						>
							<span className="size-dot" style={{ width: s + 4, height: s + 4 }} />
						</button>
					))}
				</div>
			</div>
		</>
	);
}

// ── Chat / Guess panel ─────────────────────────────────────────────────

function ChatPanel({
	game,
	userName,
	userId,
	isDrawer,
	hasGuessed,
}: {
	game: Game;
	userName: string;
	userId: string;
	isDrawer: boolean;
	hasGuessed: boolean;
}) {
	const { rows, insert } = useSync<Message>("messages", {
		params: { gameId: game.id },
	});
	const [draft, setDraft] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);

	const sorted = useMemo(
		() => [...rows].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
		[rows],
	);

	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [sorted.length]);

	const guessLocked =
		game.mode === "pictionary" &&
		((isDrawer && (game.state === "drawing" || game.state === "picking")) ||
			(hasGuessed && game.state === "drawing"));

	const handleSend = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			const text = draft.trim();
			if (!text) return;
			if (guessLocked) return;
			const id = crypto.randomUUID();
			insert(id, { id, gameId: game.id, text } as never);
			setDraft("");
		},
		[draft, insert, game.id, guessLocked],
	);

	const placeholder =
		game.mode === "pictionary"
			? isDrawer && game.state === "picking"
				? "Pick a word above first..."
				: isDrawer && game.state === "drawing"
					? "Drawer can't chat — let them guess!"
					: hasGuessed && game.state === "drawing"
						? "You already guessed it — wait for the round to end"
						: game.state === "drawing"
							? "Type your guess..."
							: "Type a message..."
			: "Type a message...";

	return (
		<div className="chat">
			<h3 className="chat-header">
				{game.mode === "pictionary" ? "Chat & guesses" : "Chat"}
			</h3>
			<div className="chat-messages" ref={scrollRef}>
				{sorted.length === 0 && <div className="chat-empty">No messages yet</div>}
				{sorted.map((m) => (
					<div
						key={m.id}
						className={`chat-msg kind-${m.kind} ${m.createdByUserId === userId ? "mine" : ""}`}
					>
						<span className="chat-author">{m.createdBy}</span>
						<span className="chat-text">{m.text}</span>
					</div>
				))}
			</div>
			<form className="chat-input" onSubmit={handleSend}>
				<input
					type="text"
					placeholder={placeholder}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					disabled={guessLocked}
					autoFocus
				/>
				<button type="submit" disabled={!draft.trim() || guessLocked}>
					{game.mode === "pictionary" && game.state === "drawing" && !isDrawer
						? "Guess"
						: "Send"}
				</button>
			</form>
		</div>
	);
}

// ── Game Room ───────────────────────────────────────────────────────────

function GameRoom({
	gameId,
	userName,
	userId,
	onLeave,
}: {
	gameId: string;
	userName: string;
	userId: string;
	onLeave: () => void;
}) {
	const { rows: gameRows, update: updateGame } = useSync<Game>("games");
	const game = useMemo(() => gameRows.find((g) => g.id === gameId), [gameRows, gameId]);

	const { rows: playerRows, insert: insertPlayer } = useSync<Player>("players", {
		params: { gameId },
	});

	// Drawer-only secret word — server filters this query per-user, so
	// guessers always see an empty rows array.
	const { rows: roundWordRows } = useSync<RoundWord>("roundWord", {
		params: { gameId },
	});
	const drawerWord = roundWordRows[0]?.word ?? "";
	const drawerOptions = useMemo(
		() => safeJson<string[]>(roundWordRows[0]?.options ?? "[]", []),
		[roundWordRows],
	);

	useEffect(() => {
		const id = `${gameId}:${userId}`;
		insertPlayer(id, { id, gameId, userId, name: userName } as never);
	}, [gameId, userId, userName, insertPlayer]);

	const isDrawer = game?.currentDrawerId === userId;
	const hasGuessed = useMemo(
		() =>
			game ? safeJson<string[]>(game.correctGuessers, []).includes(userId) : false,
		[game, userId],
	);
	const winner = useMemo(() => {
		if (!game || game.state !== "finished") return null;
		const scores = safeJson<Record<string, ScoreEntry>>(game.scores, {});
		let best: { name: string; score: number } | null = null;
		for (const entry of Object.values(scores)) {
			if (!best || entry.score > best.score) best = entry;
		}
		return best;
	}, [game]);

	const handleStart = useCallback(() => {
		if (!game) return;
		updateGame(game.id, { _action: "start" } as never);
	}, [updateGame, game]);

	const handleReset = useCallback(() => {
		if (!game) return;
		updateGame(game.id, { _action: "reset" } as never);
	}, [updateGame, game]);

	const handlePick = useCallback(
		(word: string) => {
			if (!game) return;
			updateGame(game.id, { _action: `pick:${word}` } as never);
		},
		[updateGame, game],
	);

	if (!game) {
		return (
			<div className="loading">
				Loading room...
				<button type="button" className="link-btn" onClick={onLeave}>
					← Lobby
				</button>
			</div>
		);
	}

	const canDraw =
		game.mode === "freeform" || (game.mode === "pictionary" && game.state === "drawing" && isDrawer);
	const canStart = game.mode === "pictionary" && playerRows.length >= 2;

	return (
		<div className="game-room">
			<header className="room-header">
				<button type="button" className="back-btn" onClick={onLeave}>
					← Lobby
				</button>
				<div className="room-title">
					<span className={`room-mode ${game.mode}`}>
						{game.mode === "pictionary" ? "Pictionary" : "Draw"}
					</span>
					<h1>{game.name}</h1>
				</div>
				<div className="room-actions">
					{game.mode === "pictionary" && game.state !== "waiting" && (
						<button type="button" className="reset-btn" onClick={handleReset}>
							Reset
						</button>
					)}
				</div>
			</header>

			{game.mode === "pictionary" && (
				<PictionaryHUD
					game={game}
					isDrawer={isDrawer}
					drawerWord={drawerWord}
					drawerOptions={drawerOptions}
					onStart={handleStart}
					onReset={handleReset}
					onPick={handlePick}
					canStart={canStart}
					winner={winner}
				/>
			)}

			<div className="game-body">
				<main className="game-main">
					<Canvas
						game={game}
						canDraw={canDraw}
						isDrawer={isDrawer}
						userName={userName}
						userId={userId}
					/>
				</main>

				<div className="game-side">
					{game.mode === "pictionary" && (
						<PlayerSidebar game={game} players={playerRows} userId={userId} />
					)}
					<ChatPanel
						game={game}
						userName={userName}
						userId={userId}
						isDrawer={isDrawer}
						hasGuessed={hasGuessed}
					/>
				</div>
			</div>
		</div>
	);
}

// ── Status Bar ──────────────────────────────────────────────────────────

function StatusBar({ userName, onSignOut }: { userName: string; onSignOut: () => void }) {
	const status = useSyncStatus();
	return (
		<header className="topbar">
			<div className="header-left">
				<span className="brand">reflectdb</span>
				<div className={`status ${status}`}>{status === "synced" ? "Connected" : status}</div>
			</div>
			<div className="header-right">
				<span className="user-name">{userName}</span>
				<button type="button" className="sign-out" onClick={onSignOut}>
					Sign out
				</button>
			</div>
		</header>
	);
}

// ── App Shell ───────────────────────────────────────────────────────────

function Shell({ userName, userId }: { userName: string; userId: string }) {
	const [activeGame, setActiveGame] = useState<string | null>(null);
	const handleSignOut = useCallback(async () => {
		await authClient.signOut();
	}, []);

	return (
		<>
			<StatusBar userName={userName} onSignOut={handleSignOut} />
			{activeGame ? (
				<GameRoom
					key={activeGame}
					gameId={activeGame}
					userName={userName}
					userId={userId}
					onLeave={() => setActiveGame(null)}
				/>
			) : (
				<Lobby onEnter={setActiveGame} userId={userId} />
			)}
		</>
	);
}

function AuthenticatedApp({
	token,
	userName,
	userId,
}: {
	token: string;
	userName: string;
	userId: string;
}) {
	return (
		<SyncProvider url={SYNC_URL} token={token} tables={["games"]}>
			<Shell userName={userName} userId={userId} />
		</SyncProvider>
	);
}

export function App() {
	const { data: session, isPending } = authClient.useSession();
	if (isPending) return <div className="loading">Loading...</div>;
	if (!session?.session) return <AuthForm />;
	const userName = session.user.name || `Guest ${session.user.id.slice(0, 4)}`;
	return (
		<AuthenticatedApp
			token={session.session.token}
			userName={userName}
			userId={session.user.id}
		/>
	);
}

export default App;
