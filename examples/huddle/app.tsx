/**
 * Huddle client. Everything WebRTC-related is one line: `<PeerMeshProvider>`
 * around the app. Cursors, drag previews and live ink are ordinary ephemeral
 * frames the mesh reroutes peer-to-peer; reactions use `transport: "p2p"` and
 * never touch the server; the latency race times both routes side by side.
 */

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";
import {
	SyncProvider,
	useEphemeral,
	useSync,
	useSyncClient,
	useSyncStatus,
} from "../../src/react/index.ts";
import { PeerMeshProvider, usePeerMesh, usePeers } from "../../src/react/webrtc.tsx";
import type { PeerInfo } from "../../src/react/webrtc.tsx";
import {
	MAX_NOTES_PER_ROOM,
	NOTE_COLORS,
	REACTIONS,
	STROKE_TTL_MS,
	downsample,
	isPoint,
	isRoomId,
	mergeInkWindow,
	reactionAt,
	safeColor,
	safeName,
	starterNotes,
} from "./schema.ts";
import type { Note, Stroke } from "./schema.ts";

// ── Identity, per tab ───────────────────────────────────────────────────

const ADJECTIVES = ["brisk", "calm", "clever", "bold", "quiet", "sunny", "swift", "witty"];
const ANIMALS = ["otter", "lynx", "heron", "fox", "panda", "koala", "raven", "wren"];
const COLORS = ["#f97316", "#22c55e", "#3b82f6", "#e11d48", "#a855f7", "#14b8a6", "#eab308"];

function pick<T>(list: readonly T[]): T {
	return list[Math.floor(Math.random() * list.length)]!;
}

function remembered(key: string, make: () => string): string {
	try {
		const stored = sessionStorage.getItem(key);
		if (stored) return stored;
		const value = make();
		sessionStorage.setItem(key, value);
		return value;
	} catch {
		return make();
	}
}

const me = {
	token: remembered(
		"huddle-token",
		() => `g_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
	),
	name: remembered("huddle-name", () => `${pick(ADJECTIVES)} ${pick(ANIMALS)}`),
	color: remembered("huddle-color", () => pick(COLORS)),
};

/** A room from the URL, or a fresh private one written back into it. */
function currentRoom(): string {
	const url = new URL(location.href);
	const room = url.searchParams.get("room");
	if (isRoomId(room)) return room;
	// 64 random bits: the link is the only key to the room.
	const fresh = `${pick(ANIMALS)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
	url.searchParams.set("room", fresh);
	history.replaceState(null, "", url);
	return fresh;
}

type Cursor = { x: number; y: number; name: string; color: string };

type Drag = { id: string; x: number; y: number; done?: boolean };
type Who = { name: string; color: string };
type Tool = "move" | "draw";
type LiveStroke = { id: string; color: string; points: number[] };
type Reaction = { key: number; emoji: string; x: number; y: number };

/** Points per live-ink frame: the latest window of the stroke, overlapping the last frame's. */
const INK_WINDOW = 48;

/** `[x0, y0, x1, y1, …]` in board fractions → an SVG polyline in a 1000-wide viewBox. */
function polyline(points: number[]): string {
	let out = "";
	for (let i = 0; i + 1 < points.length; i += 2) {
		out += `${(points[i]! * 1000).toFixed(1)},${(points[i + 1]! * 562.5).toFixed(1)} `;
	}
	return out;
}

/** Count events per key, reported once a second. */
function useRates(): [Record<string, number>, (key: string) => void] {
	const counts = useRef(new Map<string, number>());
	const [rates, setRates] = useState<Record<string, number>>({});
	useEffect(() => {
		const timer = setInterval(() => {
			setRates(Object.fromEntries(counts.current));
			counts.current = new Map();
		}, 1000);
		return () => clearInterval(timer);
	}, []);
	const bump = useCallback((key: string) => {
		counts.current.set(key, (counts.current.get(key) ?? 0) + 1);
	}, []);
	return [rates, bump];
}

// ── Board ───────────────────────────────────────────────────────────────

function Board({ roomId, tool, onSent }: { roomId: string; tool: Tool; onSent: () => void }) {
	const status = useSyncStatus();
	const client = useSyncClient();
	const {
		rows: notes,
		insert,
		update,
		remove,
	} = useSync<Note>("notes", {
		params: { roomId },
	});
	const {
		rows: strokes,
		insert: insertStroke,
		remove: removeStroke,
	} = useSync<Stroke>("strokes", { params: { roomId } });
	const cursors = useEphemeral<Cursor>({ key: "cursor", userId: me.token, ttlMs: 4000 });
	const drags = useEphemeral<Drag>({ key: "drag", userId: me.token, ttlMs: 2000 });
	const boardRef = useRef<HTMLDivElement>(null);
	const [dragging, setDraggingState] = useState<Drag | null>(null);
	// Pointer events can outrun renders; handlers read the ref, rendering reads the state.
	const draggingRef = useRef<Drag | null>(null);
	const setDragging = (next: Drag | null) => {
		draggingRef.current = next;
		setDraggingState(next);
	};
	const grab = useRef({ dx: 0, dy: 0 });

	// ── Live ink: mine in a ref (pointer events outrun renders), peers' by clientId.
	const myStroke = useRef<LiveStroke | null>(null);
	const myStrokeIds = useRef<string[]>([]);
	const liveInk = useRef(new Map<string, LiveStroke>());
	const [, setInkTick] = useState(0);
	const inkFrame = useRef(0);
	const redrawInk = useCallback(() => {
		if (inkFrame.current) return;
		inkFrame.current = requestAnimationFrame(() => {
			inkFrame.current = 0;
			setInkTick((n) => n + 1);
		});
	}, []);
	// Read inside the subscription without resubscribing on every cursor move.
	const cursorColors = useRef<Record<string, Cursor>>({});
	cursorColors.current = cursors.events;

	useEffect(
		() =>
			client.subscribeEphemeral("ink", (event) => {
				const data = event.data as { id?: unknown; start?: unknown; pts?: unknown; done?: unknown };
				if (data.done === true || typeof data.id !== "string") {
					liveInk.current.delete(event.clientId);
					redrawInk();
					return;
				}
				const current = liveInk.current.get(event.clientId);
				const base =
					current?.id === data.id
						? current
						: {
								id: data.id,
								color: safeColor(cursorColors.current[event.clientId]?.color),
								points: [],
							};
				const merged = mergeInkWindow(base.points, data.start, data.pts);
				if (!merged) return;
				liveInk.current.set(event.clientId, { ...base, points: merged });
				redrawInk();
			}),
		[client, redrawInk],
	);

	const sendInk = (stroke: LiveStroke) => {
		const pairs = stroke.points.length / 2;
		const start = Math.max(0, pairs - INK_WINDOW);
		void client.sendEphemeral({
			key: "ink",
			userId: me.token,
			data: { id: stroke.id, start, pts: stroke.points.slice(start * 2) },
			ttlMs: 3000,
		});
	};

	// ── Reactions: peer-to-peer only. Never stored, never seen by the server.
	const [reactions, setReactions] = useState<Reaction[]>([]);
	const lastPointer = useRef({ x: 0.5, y: 0.5 });
	const showReaction = useCallback((emoji: string, x: number, y: number) => {
		const key = Math.random();
		setReactions((list) => [...list.slice(-40), { key, emoji, x, y }]);
		setTimeout(() => setReactions((list) => list.filter((r) => r.key !== key)), 1400);
	}, []);

	useEffect(
		() =>
			client.subscribeEphemeral("react", (event) => {
				const emoji = reactionAt(event.data.e);
				if (emoji && isPoint(event.data)) showReaction(emoji, event.data.x, event.data.y);
			}),
		[client, showReaction],
	);

	const react = useCallback(
		(index: number) => {
			const emoji = REACTIONS[index];
			if (!emoji) return;
			const { x, y } = lastPointer.current;
			showReaction(emoji, x, y);
			void client.sendEphemeral({
				key: "react",
				userId: me.token,
				data: { e: index, x, y },
				transport: "p2p",
			});
		},
		[client, showReaction],
	);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.target instanceof Element && event.target.closest("textarea, input")) return;
			const index = Number(event.key) - 1;
			if (index >= 0 && index < REACTIONS.length) react(index);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [react]);

	// A new room gets starter notes. Fixed ids make two tabs seeding at once harmless.
	// Wait a beat after "synced": the room's snapshot can land just after the
	// state flips, and an occupied room must not be reseeded.
	const seeded = useRef(false);
	useEffect(() => {
		if (seeded.current || status !== "synced" || notes.length > 0) return;
		const timer = setTimeout(() => {
			seeded.current = true;
			for (const note of starterNotes(roomId)) insert(note.id, note);
		}, 400);
		return () => clearTimeout(timer);
	}, [status, notes.length, roomId, insert]);

	const toBoard = (event: { clientX: number; clientY: number }) => {
		const rect = boardRef.current!.getBoundingClientRect();
		return {
			x: (event.clientX - rect.left) / rect.width,
			y: (event.clientY - rect.top) / rect.height,
		};
	};

	const onPointerMove = (event: ReactPointerEvent) => {
		const at = toBoard(event);
		lastPointer.current = at;
		void cursors.broadcast({ ...at, name: me.name, color: me.color });
		onSent();
		const stroke = myStroke.current;
		if (stroke) {
			const lx = stroke.points[stroke.points.length - 2]!;
			const ly = stroke.points[stroke.points.length - 1]!;
			// Skip sub-pixel moves: they add points, not ink.
			if (Math.hypot(at.x - lx, at.y - ly) > 0.002) {
				stroke.points.push(at.x, at.y);
				sendInk(stroke);
				redrawInk();
			}
		}
		const current = draggingRef.current;
		if (current) {
			const next = { id: current.id, x: at.x - grab.current.dx, y: at.y - grab.current.dy };
			setDragging(next);
			void drags.broadcast(next);
		}
	};

	const onPointerDown = (event: ReactPointerEvent) => {
		if (tool !== "draw" || event.button !== 0) return;
		const at = toBoard(event);
		myStroke.current = {
			id: `${roomId}-ink-${crypto.randomUUID().slice(0, 8)}`,
			color: me.color,
			points: [at.x, at.y],
		};
		try {
			boardRef.current?.setPointerCapture(event.pointerId);
		} catch {
			// A synthetic pointer; drawing still works inside the board.
		}
	};

	const finishStroke = () => {
		const stroke = myStroke.current;
		myStroke.current = null;
		if (!stroke) return;
		// The live stroke went peer-to-peer; the finished one is a durable op.
		if (stroke.points.length >= 4) {
			insertStroke(stroke.id, {
				id: stroke.id,
				roomId,
				color: stroke.color,
				points: downsample(stroke.points),
			});
			myStrokeIds.current.push(stroke.id);
		}
		void client.sendEphemeral({
			key: "ink",
			userId: me.token,
			data: { id: stroke.id, done: true },
		});
		redrawInk();
	};

	const undoInk = () => {
		const id = myStrokeIds.current.pop();
		if (id) removeStroke(id);
	};

	const onPointerUp = () => {
		finishStroke();
		const current = draggingRef.current;
		if (!current) return;
		// The preview went peer-to-peer; the drop is a durable op through the server.
		update(current.id, { x: current.x, y: current.y });
		void drags.broadcast({ ...current, done: true });
		setDragging(null);
	};

	const startDrag = (note: Note, event: ReactPointerEvent) => {
		if (tool !== "move") return;
		if ((event.target as HTMLElement).closest("textarea, button")) return;
		const at = toBoard(event);
		grab.current = { dx: at.x - note.x, dy: at.y - note.y };
		setDragging({ id: note.id, x: note.x, y: note.y });
		try {
			// Keep receiving moves if the pointer leaves the board mid-drag.
			boardRef.current?.setPointerCapture(event.pointerId);
		} catch {
			// Not an active pointer (a synthetic event); the drag still works on the board.
		}
	};

	/** Where a note is drawn: my drag, else a peer's live drag, else its synced position. */
	const positionOf = (note: Note): { x: number; y: number; by?: string } => {
		if (dragging?.id === note.id) return dragging;
		for (const [peerId, drag] of Object.entries(drags.events)) {
			if (drag.id === note.id && !drag.done && isPoint(drag)) {
				return { x: drag.x, y: drag.y, by: safeColor(cursors.events[peerId]?.color) };
			}
		}
		return note;
	};

	const addNote = () => {
		const id = `${roomId}-${crypto.randomUUID().slice(0, 8)}`;
		insert(id, {
			id,
			roomId,
			text: "",
			x: 0.1 + Math.random() * 0.6,
			y: 0.15 + Math.random() * 0.55,
			color: pick(NOTE_COLORS),
		});
	};

	return (
		<section className="board-wrap">
			<div className="board-toolbar">
				<button onClick={addNote} disabled={notes.length >= MAX_NOTES_PER_ROOM}>
					+ note
				</button>
				<button onClick={undoInk} disabled={tool !== "draw"}>
					undo ink
				</button>
				<span className="reactions" aria-label="Reactions">
					{REACTIONS.map((emoji, index) => (
						<button key={emoji} onClick={() => react(index)} title={`press ${index + 1}`}>
							{emoji}
						</button>
					))}
				</span>
				<span className="muted small">
					{tool === "draw"
						? `drawing · ink fades after ${STROKE_TTL_MS / 60_000} min`
						: "drag notes · double-click to edit"}{" "}
					· keys 1–5 react
				</span>
			</div>
			<div
				ref={boardRef}
				className={`board ${tool}`}
				data-testid="board"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
			>
				<svg className="ink" viewBox="0 0 1000 562.5" preserveAspectRatio="none" aria-hidden="true">
					{strokes.map((stroke) => (
						<polyline
							key={stroke.id}
							points={polyline(stroke.points)}
							stroke={safeColor(stroke.color)}
						/>
					))}
					{[...liveInk.current.values()]
						.filter((live) => !strokes.some((s) => s.id === live.id))
						.map((live) => (
							<polyline
								key={live.id}
								className="live"
								points={polyline(live.points)}
								stroke={live.color}
							/>
						))}
					{myStroke.current && (
						<polyline points={polyline(myStroke.current.points)} stroke={me.color} />
					)}
				</svg>
				{notes.map((note) => {
					const at = positionOf(note);
					return (
						<NoteCard
							key={note.id}
							note={note}
							x={at.x}
							y={at.y}
							movedBy={at.by}
							lifted={dragging?.id === note.id}
							onPointerDown={(event) => startDrag(note, event)}
							onText={(text) => update(note.id, { text })}
							onRemove={() => remove(note.id)}
						/>
					);
				})}
				{Object.entries(cursors.events)
					.filter(([, cursor]) => isPoint(cursor))
					.map(([peerId, cursor]) => (
						<div
							key={peerId}
							className="cursor"
							style={{
								left: `${cursor.x * 100}%`,
								top: `${cursor.y * 100}%`,
								["--c" as string]: safeColor(cursor.color),
							}}
						>
							<svg viewBox="0 0 14 16" aria-hidden="true">
								<path d="M0 0l13 5-5 2-2 5z" />
							</svg>
							<span>{safeName(cursor.name, "guest")}</span>
						</div>
					))}
				{reactions.map((reaction) => (
					<span
						key={reaction.key}
						className="reaction"
						style={{ left: `${reaction.x * 100}%`, top: `${reaction.y * 100}%` }}
					>
						{reaction.emoji}
					</span>
				))}
			</div>
		</section>
	);
}

function NoteCard(props: {
	note: Note;
	x: number;
	y: number;
	movedBy?: string;
	lifted: boolean;
	onPointerDown: (event: ReactPointerEvent) => void;
	onText: (text: string) => void;
	onRemove: () => void;
}) {
	const { note } = props;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(note.text);
	useEffect(() => {
		if (!editing) setDraft(note.text);
	}, [note.text, editing]);

	return (
		<div
			className={`note${props.lifted ? " lifted" : ""}${props.movedBy ? " remote" : ""}`}
			style={{
				left: `${props.x * 100}%`,
				top: `${props.y * 100}%`,
				background: note.color,
				["--by" as string]: props.movedBy ?? "transparent",
			}}
			onPointerDown={props.onPointerDown}
			onDoubleClick={() => setEditing(true)}
		>
			<button className="note-x" onClick={props.onRemove} aria-label="Delete note">
				×
			</button>
			{editing ? (
				<textarea
					autoFocus
					maxLength={140}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={() => {
						setEditing(false);
						if (draft !== note.text) props.onText(draft);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey)
							(event.target as HTMLTextAreaElement).blur();
					}}
				/>
			) : (
				<p>{note.text || <span className="placeholder">double-click to write</span>}</p>
			)}
		</div>
	);
}

// ── Latency race ────────────────────────────────────────────────────────

type Rtt = { direct?: number; server?: number };

/**
 * Round-trip time to each peer, measured both ways at once: a ping sent
 * peer-to-peer and one sent through the server, each answered on the same
 * route. Every peer answers every ping, so one round costs two sends.
 */
function useLatencyRace(): Record<string, Rtt> {
	const client = useSyncClient();
	const mesh = usePeerMesh();
	const [rtt, setRtt] = useState<Record<string, Rtt>>({});
	const sent = useRef(new Map<number, number>());

	useEffect(() => {
		if (!mesh) return;
		const routes = [
			{ ping: "ping", pong: "pong", transport: "p2p", field: "direct" },
			{ ping: "ping-s", pong: "pong-s", transport: "server", field: "server" },
		] as const;
		const unsubscribes: Array<() => void> = [];
		for (const route of routes) {
			// Answer a ping on the route it came in on.
			unsubscribes.push(
				client.subscribeEphemeral(route.ping, (event) => {
					if (typeof event.data.n !== "number") return;
					void client.sendEphemeral({
						key: route.pong,
						userId: me.token,
						data: { to: event.clientId, n: event.data.n },
						ttlMs: 3000,
						transport: route.transport,
					});
				}),
			);
			unsubscribes.push(
				client.subscribeEphemeral(route.pong, (event) => {
					if (event.data.to !== mesh.clientId || typeof event.data.n !== "number") return;
					const at = sent.current.get(event.data.n);
					if (at === undefined) return;
					const ms = Math.round(performance.now() - at);
					setRtt((all) => {
						const previous = all[event.clientId]?.[route.field];
						// Smoothed, so one slow frame doesn't flip the race.
						const value = previous === undefined ? ms : Math.round(previous * 0.6 + ms * 0.4);
						return { ...all, [event.clientId]: { ...all[event.clientId], [route.field]: value } };
					});
				}),
			);
		}
		let n = 0;
		const timer = setInterval(() => {
			for (const route of routes) {
				n += 1;
				sent.current.set(n, performance.now());
				void client.sendEphemeral({
					key: route.ping,
					userId: me.token,
					data: { n },
					ttlMs: 3000,
					transport: route.transport,
				});
			}
			for (const key of sent.current.keys()) if (key < n - 20) sent.current.delete(key);
		}, 2000);
		return () => {
			clearInterval(timer);
			for (const unsubscribe of unsubscribes) unsubscribe();
		};
	}, [client, mesh]);

	return rtt;
}

function RaceBars({ rtt }: { rtt: Rtt | undefined }) {
	const max = Math.max(rtt?.direct ?? 0, rtt?.server ?? 0, 1);
	const bar = (label: string, ms: number | undefined, kind: string) => (
		<div className={`race ${kind}`}>
			<span>{label}</span>
			<span className="track">
				<span
					className="fill"
					style={{ width: ms === undefined ? 0 : `${Math.max(4, (ms / max) * 100)}%` }}
				/>
			</span>
			<b data-testid={`rtt-${kind}`}>{ms === undefined ? "–" : `${ms} ms`}</b>
		</div>
	);
	return (
		<div className="races">
			{bar("direct", rtt?.direct, "direct")}
			{bar("server", rtt?.server, "server")}
		</div>
	);
}

// ── Side panel: who is here, and how their frames arrive ───────────────

const ROUTE_LABEL: Record<PeerInfo["state"], string> = {
	connected: "direct",
	connecting: "connecting",
	"server-only": "via server",
};

function routeLabel(peer: PeerInfo): string {
	return peer.state === "connected" && peer.relayed ? "relayed" : ROUTE_LABEL[peer.state];
}

function Panel({ sentPerSecond }: { sentPerSecond: number }) {
	const client = useSyncClient();
	const mesh = usePeerMesh();
	const peers = usePeers();
	const who = useEphemeral<Who>({
		key: "who",
		userId: me.token,
		ttlMs: 60_000,
		transport: "server",
	});
	const [received, bumpReceived] = useRates();
	const race = useLatencyRace();
	const [serverPerSecond, setServerPerSecond] = useState(0);

	// Names travel through the server so every peer, direct or not, can label the
	// others. Sent again once synced: a frame sent before the room subscription
	// exists has no audience.
	const status = useSyncStatus();
	const { broadcast: announceWho } = who;
	useEffect(() => {
		if (status !== "synced") return;
		const send = () => void announceWho({ name: me.name, color: me.color });
		send();
		const timer = setInterval(send, 20_000);
		return () => clearInterval(timer);
	}, [announceWho, status]);

	useEffect(
		() => client.subscribeEphemeral("cursor", (event) => bumpReceived(event.clientId)),
		[client, bumpReceived],
	);

	useEffect(() => {
		const timer = setInterval(async () => {
			if (!mesh) return;
			try {
				const res = await fetch(`/stats?id=${encodeURIComponent(mesh.clientId)}`);
				setServerPerSecond(((await res.json()) as { cursorPerSecond: number }).cursorPerSecond);
			} catch {
				// Offline for a moment; the next tick retries.
			}
		}, 1000);
		return () => clearInterval(timer);
	}, [mesh]);

	return (
		<aside className="panel">
			<h2>Your cursor</h2>
			<div className="meter" data-testid="meter">
				<div>
					<strong data-testid="sent">{sentPerSecond}</strong>
					<small>frames/s sent</small>
				</div>
				<div>
					<strong data-testid="via-server">{serverPerSecond}</strong>
					<small>reached the server</small>
				</div>
			</div>
			<p className="muted small">
				{peers.some((p) => p.state === "connected")
					? "Everyone here is direct, so the server gets a throttled copy and peers get every frame."
					: "Nobody to connect to yet: every frame goes through the server. Open a second tab."}
			</p>

			<h2>
				In this room <span className="muted">({peers.length + 1})</span>
			</h2>
			<p className="muted small">Round trip to each peer: straight there, or through the server.</p>
			<ul className="peers" data-testid="peers">
				<li>
					<span className="dot" style={{ background: me.color }} />
					<span className="name">{me.name} (you)</span>
				</li>
				{peers.map((peer) => {
					const label = who.events[peer.clientId];
					return (
						<li key={peer.clientId}>
							<span className="dot" style={{ background: safeColor(label?.color) }} />
							<span className="name">{safeName(label?.name, peer.clientId)}</span>
							<span
								className={`route ${peer.state === "connected" && peer.relayed ? "relayed" : peer.state}`}
								data-testid={`route-${peer.clientId}`}
							>
								{routeLabel(peer)}
							</span>
							<span className="rate">{received[peer.clientId] ?? 0}/s</span>
							<RaceBars rtt={race[peer.clientId]} />
						</li>
					);
				})}
			</ul>
		</aside>
	);
}

// ── App ─────────────────────────────────────────────────────────────────

function Room({
	roomId,
	relayOnly,
	turnAvailable,
	onRelayOnly,
}: {
	roomId: string;
	relayOnly: boolean;
	turnAvailable: boolean;
	onRelayOnly: (on: boolean) => void;
}) {
	const status = useSyncStatus();
	const [rates, bumpSent] = useRates();
	const [copied, setCopied] = useState(false);
	const [tool, setTool] = useState<Tool>("move");
	const onSent = useCallback(() => bumpSent("me"), [bumpSent]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.target instanceof Element && event.target.closest("textarea, input")) return;
			if (event.key === "d") setTool("draw");
			if (event.key === "v") setTool("move");
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const copyLink = async () => {
		try {
			await navigator.clipboard.writeText(location.href);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard blocked; the URL bar still has it.
		}
	};

	return (
		<>
			<header>
				<h1>
					<span className="logo">reflectdb</span> huddle
				</h1>
				<span className="room">
					room <code>{roomId}</code>
				</span>
				<button onClick={copyLink}>{copied ? "copied" : "copy link"}</button>
				<button onClick={() => window.open(location.href, "_blank")}>open a second tab</button>
				<span className="tools" role="group" aria-label="Tool">
					<button
						className={tool === "move" ? "on" : undefined}
						onClick={() => setTool("move")}
						title="V"
					>
						move
					</button>
					<button
						className={tool === "draw" ? "on" : undefined}
						onClick={() => setTool("draw")}
						title="D"
					>
						draw
					</button>
				</span>
				<label
					className="toggle"
					title={
						turnAvailable
							? "Route everything through TURN so peers never see your IP address"
							: "This server has no TURN configured"
					}
				>
					<input
						type="checkbox"
						checked={relayOnly}
						disabled={!turnAvailable}
						onChange={(event) => onRelayOnly(event.target.checked)}
					/>
					relay only
				</label>
				<span className={`status ${status}`}>{status}</span>
			</header>
			<main>
				<Board roomId={roomId} tool={tool} onSent={onSent} />
				<Panel sentPerSecond={rates.me ?? 0} />
			</main>
			<footer className="muted small">
				Cursors, drags and live ink go peer-to-peer over WebRTC; reactions never touch the server;
				finished notes and strokes sync through it.{" "}
				<a href="https://github.com/TimMikeladze/reflectdb/tree/main/examples/huddle">source</a> ·{" "}
				<a href="https://reflectdb.dev">reflectdb</a>
			</footer>
		</>
	);
}

function App() {
	const roomId = useMemo(currentRoom, []);
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const [turnAvailable, setTurnAvailable] = useState(false);
	const [relayOnly, setRelayOnly] = useState(false);

	useEffect(() => {
		fetch("/config")
			.then((res) => res.json() as Promise<{ turn: boolean }>)
			.then((config) => setTurnAvailable(config.turn))
			.catch(() => {});
	}, []);

	return (
		<SyncProvider url={`${scheme}://${location.host}/sync`} token={me.token}>
			{/* The mesh reads its config once, so a new key rebuilds it with the new policy.
			    No iceServers: the mesh asks this server, which mints TURN credentials if it has a provider. */}
			<PeerMeshProvider key={relayOnly ? "relay" : "any"} relayOnly={relayOnly}>
				<Room
					roomId={roomId}
					relayOnly={relayOnly}
					turnAvailable={turnAvailable}
					onRelayOnly={setRelayOnly}
				/>
			</PeerMeshProvider>
		</SyncProvider>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
