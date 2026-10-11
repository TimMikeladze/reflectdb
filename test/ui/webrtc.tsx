/**
 * Two-tab check for the WebRTC peer mesh: open /webrtc in two tabs.
 * Moving over the pad sends cursor frames (transport "auto"); the stats panel
 * shows what the server actually received, so the P2P path is visible as the
 * server rate dropping to ~10/s while the peer still sees every frame.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { SyncProvider, useEphemeral, useSyncClient } from "../../src/react/index.ts";
import { PeerMeshProvider, useCall, usePeers, usePeerMesh } from "../../src/react/webrtc.tsx";
import type { CallParticipant } from "../../src/react/webrtc.tsx";

const hue = Math.floor(Math.random() * 360);
const color = `hsl(${hue}, 70%, 60%)`;

function Pad() {
	const { events, broadcast } = useEphemeral<{ x: number; y: number; color: string }>({
		key: "cursor",
		userId: "player",
		ttlMs: 5000,
	});
	const client = useSyncClient();
	const [total, setTotal] = useState(0);
	// Every frame delivered to this tab, however it arrived.
	useEffect(() => client.subscribeEphemeral("cursor", () => setTotal((n) => n + 1)), [client]);
	const received = useRef(0);
	const [rate, setRate] = useState(0);
	useEffect(() => {
		received.current++;
	}, [events]);
	useEffect(() => {
		const t = setInterval(() => {
			setRate(received.current);
			received.current = 0;
		}, 1000);
		return () => clearInterval(t);
	}, []);

	return (
		<div className="panel">
			<div
				className="pad"
				data-testid="pad"
				onMouseMove={(e) => {
					const r = e.currentTarget.getBoundingClientRect();
					void broadcast({
						x: Math.round(e.clientX - r.left),
						y: Math.round(e.clientY - r.top),
						color,
					});
				}}
			>
				{Object.entries(events).map(([id, c]) => (
					<div
						key={id}
						className="cursor"
						style={{ left: c.x, top: c.y, background: c.color }}
						title={id}
					/>
				))}
			</div>
			<p data-testid="peer-cursors">
				peer cursors: {Object.keys(events).length} · updates rendered/s:{" "}
				<b data-testid="rx-rate">{rate}</b> · frames received: <b data-testid="rx-total">{total}</b>
			</p>
		</div>
	);
}

function Stats() {
	const client = useSyncClient();
	const [stats, setStats] = useState<Record<string, number>>({});
	useEffect(() => {
		const t = setInterval(async () => {
			const res = await fetch("/stats");
			setStats(await res.json());
		}, 1000);
		return () => clearInterval(t);
	}, []);
	const mine = stats[client.getClientId()] ?? 0;
	return (
		<p className="panel" data-testid="server-rate">
			cursor frames this tab has sent through the server: <b data-testid="tx-server">{mine}</b>
		</p>
	);
}

function Peers() {
	const mesh = usePeerMesh();
	const peers = usePeers();
	return (
		<div className="panel">
			<p>
				me: <code data-testid="me">{mesh?.clientId ?? "…"}</code>
			</p>
			<table data-testid="peers">
				<thead>
					<tr>
						<th>peer</th>
						<th>state</th>
						<th>in call</th>
					</tr>
				</thead>
				<tbody>
					{peers.map((p) => (
						<tr key={p.clientId}>
							<td>{p.clientId}</td>
							<td data-testid={`state-${p.clientId}`}>{p.state}</td>
							<td>{p.inCall ? "yes" : "no"}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Video({
	stream,
	muted,
	testid,
}: {
	stream: MediaStream | null;
	muted?: boolean;
	testid: string;
}) {
	const ref = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.srcObject = stream;
	}, [stream]);
	return <video ref={ref} autoPlay playsInline muted={muted} data-testid={testid} />;
}

/** A moving test pattern, so a call can be checked without a camera prompt. */
function canvasStream(label: string, fill: string): MediaStream {
	const canvas = document.createElement("canvas");
	canvas.width = 320;
	canvas.height = 240;
	const ctx = canvas.getContext("2d")!;
	let t = 0;
	setInterval(() => {
		ctx.fillStyle = fill;
		ctx.fillRect(0, 0, 320, 240);
		ctx.fillStyle = "#fff";
		ctx.font = "28px sans-serif";
		ctx.fillText(label, 20, 60);
		ctx.fillRect(20 + ((t += 4) % 260), 120, 40, 40);
	}, 33);
	return canvas.captureStream(30);
}

function Call() {
	const { call, inCall, join, leave, shareScreen, stopScreen, setMuted } = useCall();
	return (
		<div className="panel">
			<p>peers in call: {inCall}</p>
			{call ? (
				<>
					<button onClick={leave}>leave</button>
					<button
						onClick={() =>
							call.screen ? stopScreen() : void shareScreen(canvasStream("screen", "#0b3d2e"))
						}
					>
						{call.screen ? "stop share" : "share (test pattern)"}
					</button>
					<button onClick={() => setMuted({ video: !call.videoMuted })}>
						{call.videoMuted ? "video on" : "video off"}
					</button>
					<div className="row" style={{ marginTop: 8 }}>
						<div className="tile">
							me
							<Video stream={call.camera} muted testid="local-camera" />
						</div>
						{call.participants.map((p: CallParticipant) => (
							<div className="tile" key={p.clientId} data-testid="participant">
								{p.clientId} {p.videoMuted ? "(video off)" : ""}
								<Video stream={p.camera} testid="remote-camera" />
								{p.screen && <Video stream={p.screen} testid="remote-screen" />}
							</div>
						))}
					</div>
				</>
			) : (
				<button onClick={() => void join(canvasStream("camera " + color, `hsl(${hue}, 40%, 25%)`))}>
					join call (test pattern)
				</button>
			)}
		</div>
	);
}

function App() {
	return (
		<SyncProvider url={`ws://${location.host}/sync`} token="test-token" tables={["cells"]}>
			<PeerMeshProvider>
				<h1>reflectdb · webrtc mesh</h1>
				<div className="row">
					<div>
						<Pad />
						<Stats />
					</div>
					<div>
						<Peers />
						<Call />
					</div>
				</div>
			</PeerMeshProvider>
		</SyncProvider>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
