/**
 * Huddle client. Everything WebRTC-related is two lines: `<PeerMeshProvider>`
 * around the app, and `useCall()` for the video. Cursors and drag previews are
 * ordinary `useEphemeral` calls — the mesh reroutes them peer-to-peer.
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
import { PeerMeshProvider, useCall, usePeerMesh, usePeers } from "../../src/react/webrtc.tsx";
import type { CallParticipant, PeerInfo } from "../../src/react/webrtc.tsx";
import { MAX_NOTES_PER_ROOM, NOTE_COLORS, isRoomId, starterNotes } from "./schema.ts";
import type { Note } from "./schema.ts";

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
	const fresh = `${pick(ANIMALS)}-${crypto.randomUUID().slice(0, 6)}`;
	url.searchParams.set("room", fresh);
	history.replaceState(null, "", url);
	return fresh;
}

type Cursor = { x: number; y: number; name: string; color: string };
type Drag = { id: string; x: number; y: number; done?: boolean };
type Who = { name: string; color: string };

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

function Board({ roomId, onSent }: { roomId: string; onSent: () => void }) {
	const status = useSyncStatus();
	const {
		rows: notes,
		insert,
		update,
		remove,
	} = useSync<Note>("notes", {
		params: { roomId },
	});
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
		void cursors.broadcast({ ...at, name: me.name, color: me.color });
		onSent();
		const current = draggingRef.current;
		if (current) {
			const next = { id: current.id, x: at.x - grab.current.dx, y: at.y - grab.current.dy };
			setDragging(next);
			void drags.broadcast(next);
		}
	};

	const onPointerUp = () => {
		const current = draggingRef.current;
		if (!current) return;
		// The preview went peer-to-peer; the drop is a durable op through the server.
		update(current.id, { x: current.x, y: current.y });
		void drags.broadcast({ ...current, done: true });
		setDragging(null);
	};

	const startDrag = (note: Note, event: ReactPointerEvent) => {
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
			if (drag.id === note.id && !drag.done) {
				return { x: drag.x, y: drag.y, by: cursors.events[peerId]?.color };
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
				<span className="muted">
					{notes.length}/{MAX_NOTES_PER_ROOM} notes · drag to move · double-click text to edit
				</span>
			</div>
			<div
				ref={boardRef}
				className="board"
				data-testid="board"
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
			>
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
				{Object.entries(cursors.events).map(([peerId, cursor]) => (
					<div
						key={peerId}
						className="cursor"
						style={{
							left: `${cursor.x * 100}%`,
							top: `${cursor.y * 100}%`,
							["--c" as string]: cursor.color,
						}}
					>
						<svg viewBox="0 0 14 16" aria-hidden="true">
							<path d="M0 0l13 5-5 2-2 5z" />
						</svg>
						<span>{cursor.name}</span>
					</div>
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

// ── Side panel: who is here, and how their frames arrive ───────────────

const ROUTE_LABEL: Record<PeerInfo["state"], string> = {
	connected: "direct",
	connecting: "connecting",
	"server-only": "via server",
};

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
			<ul className="peers" data-testid="peers">
				<li>
					<span className="dot" style={{ background: me.color }} />
					<span className="name">{me.name} (you)</span>
				</li>
				{peers.map((peer) => {
					const label = who.events[peer.clientId];
					return (
						<li key={peer.clientId}>
							<span className="dot" style={{ background: label?.color ?? "#777" }} />
							<span className="name">{label?.name ?? peer.clientId}</span>
							<span className={`route ${peer.state}`} data-testid={`route-${peer.clientId}`}>
								{ROUTE_LABEL[peer.state]}
							</span>
							<span className="rate">{received[peer.clientId] ?? 0}/s</span>
						</li>
					);
				})}
			</ul>
		</aside>
	);
}

// ── Huddle: the call ────────────────────────────────────────────────────

/** An animated tile, for joining without a camera. */
function testPatternStream(): MediaStream {
	const canvas = document.createElement("canvas");
	canvas.width = 320;
	canvas.height = 240;
	const ctx = canvas.getContext("2d")!;
	let t = 0;
	let stream: MediaStream | null = null;
	const draw = () => {
		// leave() stops the track without firing "ended", so the loop checks.
		if (stream && stream.getVideoTracks().every((track) => track.readyState === "ended")) {
			clearInterval(timer);
			return;
		}
		t += 1;
		ctx.fillStyle = "#18181b";
		ctx.fillRect(0, 0, 320, 240);
		ctx.fillStyle = me.color;
		ctx.beginPath();
		ctx.arc(160 + Math.sin(t / 20) * 60, 110, 38, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = "#fafafa";
		ctx.font = "600 18px system-ui, sans-serif";
		ctx.textAlign = "center";
		ctx.fillText(me.name, 160, 200);
	};
	const timer = setInterval(draw, 33);
	stream = canvas.captureStream(30);
	return stream;
}

function Video({
	stream,
	mirrored,
	muted,
}: {
	stream: MediaStream | null;
	mirrored?: boolean;
	muted?: boolean;
}) {
	const ref = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.srcObject = stream;
	}, [stream]);
	return (
		<video
			ref={ref}
			autoPlay
			playsInline
			muted={muted}
			className={mirrored ? "mirrored" : undefined}
		/>
	);
}

function Huddle() {
	const { call, inCall, join, leave, shareScreen, stopScreen, setMuted } = useCall();
	const mesh = usePeerMesh();
	const who = useEphemeral<Who>({
		key: "who",
		userId: me.token,
		ttlMs: 60_000,
		transport: "server",
	});
	const [error, setError] = useState<string | null>(null);
	// Mirror a real camera, as every call app does; a test pattern has text that would read backwards.
	const [mirror, setMirror] = useState(true);
	const people = inCall + (call ? 1 : 0);

	const run = (action: () => Promise<void>) => {
		setError(null);
		action().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	const nameOf = (p: CallParticipant) => who.events[p.clientId]?.name ?? p.clientId;

	return (
		<section className="huddle" data-testid="huddle">
			<div className="huddle-bar">
				<strong>Huddle</strong>
				<span className="muted" data-testid="call-count">
					{people > 0 ? `${people} in the call` : "nobody in the call"}
				</span>
				<span className="spacer" />
				{call ? (
					<>
						<button onClick={() => setMuted({ audio: !call.audioMuted })}>
							{call.audioMuted ? "unmute" : "mute"}
						</button>
						<button onClick={() => setMuted({ video: !call.videoMuted })}>
							{call.videoMuted ? "camera on" : "camera off"}
						</button>
						<button onClick={() => (call.screen ? stopScreen() : run(() => shareScreen()))}>
							{call.screen ? "stop sharing" : "share screen"}
						</button>
						<button className="danger" onClick={leave}>
							leave
						</button>
					</>
				) : (
					<>
						<button
							className="primary"
							disabled={!mesh}
							onClick={() => {
								setMirror(true);
								run(() => join());
							}}
						>
							join with camera
						</button>
						<button
							disabled={!mesh}
							onClick={() => {
								setMirror(false);
								run(() => join(testPatternStream()));
							}}
						>
							join without camera
						</button>
					</>
				)}
			</div>
			{error && <p className="error">{error}</p>}
			{call && (
				<div className="tiles">
					<figure className="tile">
						<Video stream={call.camera} mirrored={mirror} muted />
						<figcaption>{me.name} (you)</figcaption>
					</figure>
					{call.screen && (
						<figure className="tile wide">
							<Video stream={call.screen} muted />
							<figcaption>your screen</figcaption>
						</figure>
					)}
					{call.participants.map((p) => (
						<FragmentTiles key={p.clientId} participant={p} name={nameOf(p)} />
					))}
				</div>
			)}
		</section>
	);
}

function FragmentTiles({ participant, name }: { participant: CallParticipant; name: string }) {
	return (
		<>
			<figure className="tile" data-testid="remote-tile">
				<Video stream={participant.camera} />
				<figcaption>
					{name}
					{participant.audioMuted ? " · muted" : ""}
					{participant.videoMuted ? " · camera off" : ""}
				</figcaption>
			</figure>
			{participant.screen && (
				<figure className="tile wide" data-testid="remote-screen">
					<Video stream={participant.screen} />
					<figcaption>{name}'s screen</figcaption>
				</figure>
			)}
		</>
	);
}

// ── App ─────────────────────────────────────────────────────────────────

function Room({ roomId }: { roomId: string }) {
	const status = useSyncStatus();
	const [rates, bumpSent] = useRates();
	const [copied, setCopied] = useState(false);
	const onSent = useCallback(() => bumpSent("me"), [bumpSent]);

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
				<span className={`status ${status}`}>{status}</span>
			</header>
			<main>
				<Board roomId={roomId} onSent={onSent} />
				<Panel sentPerSecond={rates.me ?? 0} />
			</main>
			<Huddle />
			<footer className="muted small">
				Cursors and drags go peer-to-peer over WebRTC; notes sync through the server.{" "}
				<a href="https://github.com/TimMikeladze/reflectdb/tree/main/examples/huddle">source</a> ·{" "}
				<a href="https://reflectdb.dev">reflectdb</a>
			</footer>
		</>
	);
}

function App() {
	const roomId = useMemo(currentRoom, []);
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return (
		<SyncProvider url={`${scheme}://${location.host}/sync`} token={me.token}>
			<PeerMeshProvider>
				<Room roomId={roomId} />
			</PeerMeshProvider>
		</SyncProvider>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
