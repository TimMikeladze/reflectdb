/**
 * WebRTC peer mesh — ephemeral frames and media go peer-to-peer, signaled over
 * the reflectdb connection the app already has. See `docs/webrtc.md`.
 *
 * Durable data never rides here. The mesh only changes the route an ephemeral
 * frame takes: connected peers get every frame over an unreliable data channel,
 * and the server keeps a throttled copy for everyone else (and for the presence
 * snapshot a joiner receives). A peer that never connects stays on the server
 * path, so attaching a mesh can only add speed, not remove delivery.
 *
 * Peers find each other through presence: each mesh keeps a `__rtc` ephemeral
 * entry alive. The peer with the lower clientId opens the connection, so the
 * first offer never collides; later renegotiation (media tracks, ICE restarts)
 * uses the standard "perfect negotiation" pattern with the higher id polite.
 */

import type { EphemeralEvent, SignalEvent } from "../core/types.ts";
import type { EphemeralRouter, SendEphemeralParams } from "./sync-client.ts";
import { EPHEMERAL_SEQ_FIELD } from "./sync-client.ts";

/** The slice of `SyncClient` the mesh drives. A typed client satisfies it too. */
export interface PeerMeshClient {
	getClientId(): string;
	getState(): string;
	subscribe(listener: () => void): () => void;
	sendEphemeral(params: SendEphemeralParams): Promise<void>;
	subscribeEphemeral(key: string, listener: (event: EphemeralEvent) => void): () => void;
	receiveEphemeral(event: EphemeralEvent): void;
	setEphemeralRouter(router: EphemeralRouter | null): void;
	sendSignal(to: string, data: Record<string, unknown>): Promise<void>;
	subscribeSignal(listener: (event: SignalEvent) => void): () => void;
}

export interface PeerMeshConfig {
	/** Default: Google's public STUN server. Add your own TURN for strict NATs. */
	iceServers?: RTCIceServer[];
	/** Full-mesh ceiling. Peers past it stay on the server path. Default: 8 */
	maxPeers?: number;
	/**
	 * Route media and data only through TURN (`iceTransportPolicy: "relay"`).
	 * Hides each peer's IP address from the others; requires a TURN server.
	 */
	relayOnly?: boolean;
	/** In `auto` mode, the server copy of a key is sent at most this often. Default: 100 */
	serverIntervalMs?: number;
	/**
	 * How often presence is refreshed. Every refresh fans out to the whole room,
	 * so this is O(room²) messages per interval; raise it for large rooms.
	 * Discovery does not wait on it. Default: 30_000
	 */
	announceIntervalMs?: number;
	/** Give up on a peer that has not connected after this long. Default: 15_000 */
	connectTimeoutMs?: number;
	/** Constructor override — a polyfill outside the browser. Default: globalThis.RTCPeerConnection */
	RTCPeerConnection?: typeof RTCPeerConnection;
}

export type PeerState = "connecting" | "connected" | "server-only";

export interface PeerInfo {
	clientId: string;
	userId: string;
	state: PeerState;
	/** The peer has joined the room's call. */
	inCall: boolean;
}

export type StreamKind = "camera" | "screen";

export interface CallParticipant {
	clientId: string;
	userId: string;
	camera: MediaStream | null;
	screen: MediaStream | null;
	audioMuted: boolean;
	videoMuted: boolean;
}

export interface CallState {
	camera: MediaStream | null;
	screen: MediaStream | null;
	audioMuted: boolean;
	videoMuted: boolean;
	participants: CallParticipant[];
}

export interface PeerMeshSnapshot {
	peers: PeerInfo[];
	/** Null until `call()` resolves, and again after `leave()`. */
	call: CallState | null;
}

export interface PeerMesh {
	/** This client's peer id, as other peers see it. */
	readonly clientId: string;
	getSnapshot(): PeerMeshSnapshot;
	subscribe(listener: () => void): () => void;
	/**
	 * Join this room's call. Pass constraints to capture the camera and mic
	 * (default: both), or a ready MediaStream — a processed or canvas stream.
	 */
	call(source?: MediaStreamConstraints | MediaStream): Promise<void>;
	/** Share the screen into the call. Pass a MediaStream to share something else. */
	shareScreen(source?: MediaStream): Promise<void>;
	stopScreen(): void;
	setMuted(muted: { audio?: boolean; video?: boolean }): void;
	/** Leave the call. Stops every local track, including those of a stream passed to `call()`. */
	leave(): void;
	/** Leave any call, close every connection, and hand ephemeral routing back to the server. */
	destroy(): void;
}

/** Presence key every mesh keeps alive. */
export const RTC_PRESENCE_KEY = "__rtc";
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** A peer silent for this many announce intervals is presumed gone. */
const PRESENCE_TTL_INTERVALS = 3;
/** After giving up on a peer, wait this long before trying it again. */
const RETRY_AFTER_MS = 60_000;
/** A signal frame carries at most this much of a split description. */
const SIGNAL_CHUNK_CHARS = 1_500;
/** Frames larger than this off the data channel are dropped unread. */
const MAX_FRAME_BYTES = 64 * 1024;
/** Above this, an unreliable channel is congested; skip rather than queue. */
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_ICE_RESTARTS = 2;
const MAX_PARTIAL_DESCRIPTIONS = 4;
const MAX_PENDING_CANDIDATES = 64;

type ControlMessage =
	| { t: "call"; on: boolean }
	| { t: "stream"; id: string; kind: StreamKind }
	| { t: "unstream"; id: string }
	| { t: "mute"; audio: boolean; video: boolean };

interface Peer {
	id: string;
	userId: string;
	pc: RTCPeerConnection;
	polite: boolean;
	eph: RTCDataChannel | null;
	ctl: RTCDataChannel | null;
	state: PeerState;
	makingOffer: boolean;
	ignoreOffer: boolean;
	pendingCandidates: RTCIceCandidateInit[];
	/** Partial descriptions, by chunk id. */
	chunks: Map<string, string[]>;
	restarts: number;
	/** Set when the mesh gave up; the peer may be tried again after this. */
	retryAt: number;
	connectTimer: ReturnType<typeof setTimeout> | null;
	remoteCall: boolean;
	streamKinds: Map<string, StreamKind>;
	remoteStreams: Map<string, MediaStream>;
	remoteMuted: { audio: boolean; video: boolean };
	/** Local stream id -> senders carrying it to this peer. */
	senders: Map<string, RTCRtpSender[]>;
}

interface KnownPeer {
	userId: string;
	inCall: boolean;
	lastSeen: number;
}

interface LocalCall {
	camera: MediaStream | null;
	screen: MediaStream | null;
	audioMuted: boolean;
	videoMuted: boolean;
}

export function createPeerMesh(client: PeerMeshClient, config: PeerMeshConfig = {}): PeerMesh {
	const PC = config.RTCPeerConnection ?? globalThis.RTCPeerConnection;
	if (!PC) throw new Error("createPeerMesh: RTCPeerConnection is not available here");
	// The server's id for this connection arrives with hello_ack, and a
	// reconnect can change it; read it again on every state change.
	let self = client.getClientId();
	const maxPeers = config.maxPeers ?? 8;
	const serverIntervalMs = config.serverIntervalMs ?? 100;
	const announceIntervalMs = config.announceIntervalMs ?? 30_000;
	const presenceTtlMs = announceIntervalMs * PRESENCE_TTL_INTERVALS;
	const connectTimeoutMs = config.connectTimeoutMs ?? 15_000;
	const rtcConfig: RTCConfiguration = {
		iceServers: config.iceServers ?? DEFAULT_ICE_SERVERS,
		...(config.relayOnly ? { iceTransportPolicy: "relay" } : {}),
	};

	const peers = new Map<string, Peer>();
	/** Everyone announcing on `__rtc`, connected or not. */
	const known = new Map<string, KnownPeer>();
	const listeners = new Set<() => void>();
	let local: LocalCall | null = null;
	/** A capture in flight, so a second call() or shareScreen() waits on it instead of opening another device. */
	let joining: Promise<void> | null = null;
	/** Bumped by leave(); a join that resolves under an older value was cancelled. */
	let callEpoch = 0;
	let sharing: Promise<void> | null = null;
	let destroyed = false;
	let snapshot: PeerMeshSnapshot = { peers: [], call: null };
	let seq = 0;
	const lastServerSend = new Map<string, number>();
	const trailing = new Map<
		string,
		{ params: SendEphemeralParams; timer: ReturnType<typeof setTimeout> }
	>();

	// ── Change notification ─────────────────────────────────────────────

	function changed(): void {
		const peerList: PeerInfo[] = [];
		for (const [id, info] of known) {
			const peer = peers.get(id);
			peerList.push({
				clientId: id,
				userId: info.userId,
				state: peer?.state ?? "server-only",
				inCall: info.inCall,
			});
		}
		peerList.sort((a, b) => (a.clientId < b.clientId ? -1 : 1));
		let call: CallState | null = null;
		if (local) {
			const participants: CallParticipant[] = [];
			for (const peer of peers.values()) {
				if (!peer.remoteCall || peer.state !== "connected") continue;
				let camera: MediaStream | null = null;
				let screen: MediaStream | null = null;
				for (const [id, stream] of peer.remoteStreams) {
					if (peer.streamKinds.get(id) === "screen") screen = stream;
					else camera = stream;
				}
				participants.push({
					clientId: peer.id,
					userId: peer.userId,
					camera,
					screen,
					audioMuted: peer.remoteMuted.audio,
					videoMuted: peer.remoteMuted.video,
				});
			}
			participants.sort((a, b) => (a.clientId < b.clientId ? -1 : 1));
			call = { ...local, participants };
		}
		snapshot = { peers: peerList, call };
		for (const listener of listeners) listener();
	}

	// ── Presence ────────────────────────────────────────────────────────

	function announce(): void {
		if (destroyed) return;
		void client
			.sendEphemeral({
				key: RTC_PRESENCE_KEY,
				userId: "",
				data: { v: 1, call: local !== null },
				ttlMs: presenceTtlMs,
				transport: "server",
			})
			.catch(() => {});
	}

	const unsubPresence = client.subscribeEphemeral(RTC_PRESENCE_KEY, (event) => {
		if (event.clientId === self || destroyed) return;
		const inCall = event.data.call === true;
		const previous = known.get(event.clientId);
		known.set(event.clientId, { userId: event.userId, inCall, lastSeen: Date.now() });
		let peer = peers.get(event.clientId);
		if (peer && retryable(peer)) {
			peers.delete(peer.id);
			peer = undefined;
		}
		if (peer) {
			if (peer.remoteCall !== inCall) setRemoteCall(peer, inCall);
		} else if (self < event.clientId) {
			openPeer(event.clientId, event.userId, false);
		} else if (!previous && activeCount() < maxPeers) {
			// They open the connection, but may not know we exist: rooms without
			// a presence snapshot only learn of us at our next announce. Tell
			// them directly — one targeted signal, not a room-wide broadcast.
			signal(event.clientId, { t: "hello" });
		}
		if (!previous || previous.inCall !== inCall) changed();
	});

	// Announce once the connection can deliver it: an announce sent before the
	// client has joined a room reaches nobody.
	let lastState = client.getState();
	const unsubState = client.subscribe(() => {
		const state = client.getState();
		if (state === lastState) return;
		lastState = state;
		if (state !== "synced" && state !== "connected") return;
		const id = client.getClientId();
		if (id !== self) {
			// Peers knew us by the old id; their connections are to someone
			// who no longer exists. Start over under the new one.
			self = id;
			for (const peer of peers.values()) closePeer(peer);
			known.clear();
			changed();
		}
		announce();
	});

	const announceTimer = setInterval(() => {
		announce();
		// Forget silent peers that never connected; a connected one is tracked
		// by its connection instead.
		const cutoff = Date.now() - presenceTtlMs;
		let pruned = false;
		for (const [id, info] of known) {
			if (info.lastSeen >= cutoff) continue;
			const peer = peers.get(id);
			// A peer we gave up on has no connection to report its departure,
			// so silence is the only signal it left.
			if (!peer || peer.state === "server-only") {
				known.delete(id);
				peers.delete(id);
				pruned = true;
			}
		}
		if (pruned) changed();
	}, announceIntervalMs);
	(announceTimer as { unref?: () => void }).unref?.();
	announce();

	// A closing tab tears its connections down without telling anyone; closing
	// them first lets peers see the departure at once instead of after ICE
	// gives up on the silence.
	const onPageHide = (event: Event) => {
		// A page entering the back/forward cache may come back; let ICE decide.
		if ((event as PageTransitionEvent).persisted) return;
		mesh.destroy();
	};
	globalThis.addEventListener?.("pagehide", onPageHide);

	// ── Signaling ───────────────────────────────────────────────────────

	function signal(to: string, data: Record<string, unknown>): void {
		void client.sendSignal(to, data).catch(() => {});
	}

	/** Descriptions can outgrow one signal frame (video SDP is several KB); split them. */
	function sendDescription(peer: Peer, description: RTCSessionDescriptionInit): void {
		const body = JSON.stringify({ type: description.type, sdp: description.sdp });
		if (body.length <= SIGNAL_CHUNK_CHARS) {
			signal(peer.id, { t: "desc", d: body });
			return;
		}
		const id = Math.random().toString(36).slice(2, 10);
		const n = Math.ceil(body.length / SIGNAL_CHUNK_CHARS);
		for (let i = 0; i < n; i++) {
			signal(peer.id, {
				t: "part",
				id,
				i,
				n,
				p: body.slice(i * SIGNAL_CHUNK_CHARS, (i + 1) * SIGNAL_CHUNK_CHARS),
			});
		}
	}

	// One at a time, in arrival order: an answer must not be built while the
	// offer before it is still being applied, and a candidate must not race the
	// description it belongs to.
	let signalChain: Promise<void> = Promise.resolve();
	const unsubSignal = client.subscribeSignal((event) => {
		if (destroyed) return;
		signalChain = signalChain
			.then(() => (destroyed ? undefined : handleSignal(event)))
			.catch((err) => {
				console.error("[reflectdb] webrtc signal failed:", err);
			});
	});

	async function handleSignal(event: SignalEvent): Promise<void> {
		const data = event.data;
		let peer = peers.get(event.from);
		if (peer?.state === "server-only") {
			// Given up on. A fresh offer after the cool-down starts over;
			// anything else is a straggler for the closed connection.
			if (!retryable(peer)) return;
			peers.delete(peer.id);
			peer = undefined;
		}
		if (data.t === "hello") {
			if (peer || !(self < event.from)) return;
			known.set(event.from, { userId: event.userId, inCall: false, lastSeen: Date.now() });
			openPeer(event.from, event.userId, false);
			return;
		}
		if (!peer) {
			// Only the lower id opens a connection; anything else is stale.
			if (!(event.from < self) || (data.t !== "desc" && data.t !== "part")) return;
			const opened = openPeer(event.from, event.userId, true);
			if (!opened) return;
			peer = opened;
		}

		if (data.t === "part") {
			if (typeof data.id !== "string" || typeof data.i !== "number" || typeof data.n !== "number")
				return;
			if (typeof data.p !== "string" || data.n > 64 || data.i < 0 || data.i >= data.n) return;
			let parts = peer.chunks.get(data.id);
			if (!parts) {
				// Only a description or two is ever in flight; unfinished ones a
				// peer abandons must not accumulate.
				if (peer.chunks.size >= MAX_PARTIAL_DESCRIPTIONS) {
					const oldest = peer.chunks.keys().next().value;
					if (oldest !== undefined) peer.chunks.delete(oldest);
				}
				parts = Array.from<string>({ length: data.n });
				peer.chunks.set(data.id, parts);
			}
			parts[data.i] = data.p;
			for (let i = 0; i < data.n; i++) if (parts[i] === undefined) return;
			peer.chunks.delete(data.id);
			await applyDescription(peer, parts.join(""));
		} else if (data.t === "desc" && typeof data.d === "string") {
			await applyDescription(peer, data.d);
		} else if (data.t === "ice" && data.c && typeof data.c === "object") {
			const candidate = data.c as RTCIceCandidateInit;
			if (!peer.pc.remoteDescription) {
				if (peer.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
					peer.pendingCandidates.push(candidate);
				}
				return;
			}
			try {
				await peer.pc.addIceCandidate(candidate);
			} catch (err) {
				if (!peer.ignoreOffer) throw err;
			}
		}
	}

	async function applyDescription(peer: Peer, body: string): Promise<void> {
		const description = JSON.parse(body) as RTCSessionDescriptionInit;
		if (description.type !== "offer" && description.type !== "answer") return;
		const pc = peer.pc;
		const collision =
			description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
		peer.ignoreOffer = !peer.polite && collision;
		if (peer.ignoreOffer) return;

		await pc.setRemoteDescription(description);
		for (const candidate of peer.pendingCandidates.splice(0)) {
			await pc.addIceCandidate(candidate).catch(() => {});
		}
		if (description.type === "offer") {
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			sendDescription(peer, pc.localDescription ?? answer);
		}
	}

	// ── Connections ─────────────────────────────────────────────────────

	/** A peer given up on whose cool-down has passed: a fresh attempt may succeed. */
	function retryable(peer: Peer): boolean {
		return peer.state === "server-only" && Date.now() >= peer.retryAt;
	}

	function activeCount(): number {
		let n = 0;
		for (const peer of peers.values()) if (peer.state !== "server-only") n++;
		return n;
	}

	function openPeer(id: string, userId: string, responder: boolean): Peer | null {
		if (destroyed || activeCount() >= maxPeers) return null;
		if (!known.has(id)) known.set(id, { userId, inCall: false, lastSeen: Date.now() });

		const pc = new PC(rtcConfig);
		const peer: Peer = {
			id,
			userId,
			pc,
			// The responder is the polite side: it yields on a collision.
			polite: self > id,
			eph: null,
			ctl: null,
			state: "connecting",
			makingOffer: false,
			ignoreOffer: false,
			pendingCandidates: [],
			chunks: new Map(),
			restarts: 0,
			retryAt: 0,
			connectTimer: null,
			remoteCall: known.get(id)?.inCall ?? false,
			streamKinds: new Map(),
			remoteStreams: new Map(),
			remoteMuted: { audio: false, video: false },
			senders: new Map(),
		};
		peers.set(id, peer);

		pc.onicecandidate = (event) => {
			if (event.candidate)
				signal(id, { t: "ice", c: event.candidate.toJSON?.() ?? event.candidate });
		};
		pc.onnegotiationneeded = async () => {
			try {
				peer.makingOffer = true;
				const offer = await pc.createOffer();
				// A remote offer landed while ours was being built; answer that instead.
				if (pc.signalingState === "have-remote-offer") return;
				await pc.setLocalDescription(offer);
				sendDescription(peer, pc.localDescription ?? offer);
			} catch (err) {
				console.error("[reflectdb] webrtc negotiation failed:", err);
			} finally {
				peer.makingOffer = false;
			}
		};
		pc.onconnectionstatechange = () => onConnectionState(peer);
		pc.ondatachannel = (event) => bindChannel(peer, event.channel);
		pc.ontrack = (event) => {
			const stream = event.streams[0];
			if (!stream) return;
			peer.remoteStreams.set(stream.id, stream);
			stream.onremovetrack = () => {
				if (stream.getTracks().length === 0) {
					peer.remoteStreams.delete(stream.id);
					changed();
				}
			};
			changed();
		};

		if (!responder) {
			bindChannel(peer, pc.createDataChannel("eph", { ordered: false, maxRetransmits: 0 }));
			bindChannel(peer, pc.createDataChannel("ctl"));
		}

		peer.connectTimer = setTimeout(() => {
			if (peer.state === "connecting") giveUp(peer);
		}, connectTimeoutMs);
		(peer.connectTimer as { unref?: () => void }).unref?.();
		changed();
		return peer;
	}

	function bindChannel(peer: Peer, channel: RTCDataChannel): void {
		if (channel.label === "eph") {
			peer.eph = channel;
			channel.onmessage = (event) => receiveFrame(peer, event.data);
		} else if (channel.label === "ctl") {
			peer.ctl = channel;
			channel.onmessage = (event) => receiveControl(peer, event.data);
		} else {
			return;
		}
		channel.onopen = () => onChannelOpen(peer);
		channel.onclose = () => peerLeft(peer);
		if (channel.readyState === "open") onChannelOpen(peer);
	}

	function onChannelOpen(peer: Peer): void {
		if (peer.state !== "connecting") return;
		if (peer.eph?.readyState !== "open" || peer.ctl?.readyState !== "open") return;
		if (peer.pc.connectionState === "disconnected" || peer.pc.connectionState === "failed") return;
		peer.state = "connected";
		peer.restarts = 0;
		if (peer.connectTimer) clearTimeout(peer.connectTimer);
		peer.connectTimer = null;
		if (local) {
			sendControl(peer, { t: "call", on: true });
			sendControl(peer, { t: "mute", audio: local.audioMuted, video: local.videoMuted });
			if (peer.remoteCall) attachMedia(peer);
		}
		changed();
	}

	function onConnectionState(peer: Peer): void {
		const state = peer.pc.connectionState;
		if (state === "disconnected" || state === "failed") {
			if (peer.state === "connected") {
				// Off the direct path until it recovers: `auto` must not throttle
				// the server copy for a peer that is not getting frames.
				peer.state = "connecting";
				armLostTimer(peer);
				changed();
			}
			if (state === "failed" && peer.restarts < MAX_ICE_RESTARTS) {
				peer.restarts++;
				try {
					peer.pc.restartIce();
				} catch {
					// Not supported by this implementation; the lost timer decides.
				}
			}
		} else if (state === "connected") {
			onChannelOpen(peer);
		} else if (state === "closed") {
			peerLeft(peer);
		}
	}

	/**
	 * A connection that dropped and does not recover in time is treated as the
	 * peer having left (a closed tab, a crash, a lost network). If it is still
	 * there, its next announce reconnects it.
	 */
	function armLostTimer(peer: Peer): void {
		if (peer.connectTimer) clearTimeout(peer.connectTimer);
		peer.connectTimer = setTimeout(() => {
			if (peer.state === "connecting") peerLeft(peer);
		}, connectTimeoutMs);
		(peer.connectTimer as { unref?: () => void }).unref?.();
	}

	/**
	 * The far side closed the connection: it left, or dropped its mesh. Forget
	 * it until it announces again, rather than list it as reachable through
	 * the server. (Our own teardown detaches these handlers first.)
	 */
	function peerLeft(peer: Peer): void {
		if (peers.get(peer.id) !== peer) return;
		known.delete(peer.id);
		closePeer(peer);
	}

	/** Stop trying: the peer stays reachable through the server for this session. */
	function giveUp(peer: Peer): void {
		teardown(peer);
		peer.state = "server-only";
		peer.retryAt = Date.now() + RETRY_AFTER_MS;
		changed();
	}

	function closePeer(peer: Peer): void {
		teardown(peer);
		peers.delete(peer.id);
		changed();
	}

	function teardown(peer: Peer): void {
		if (peer.connectTimer) clearTimeout(peer.connectTimer);
		peer.connectTimer = null;
		const pc = peer.pc;
		pc.onicecandidate = null;
		pc.onnegotiationneeded = null;
		pc.onconnectionstatechange = null;
		pc.ondatachannel = null;
		pc.ontrack = null;
		for (const channel of [peer.eph, peer.ctl]) {
			if (!channel) continue;
			channel.onmessage = null;
			channel.onopen = null;
			channel.onclose = null;
		}
		try {
			pc.close();
		} catch {
			// Already closed.
		}
		peer.eph = null;
		peer.ctl = null;
		peer.remoteStreams.clear();
		peer.senders.clear();
	}

	// ── Ephemeral frames ────────────────────────────────────────────────

	function receiveFrame(peer: Peer, raw: unknown): void {
		if (typeof raw !== "string" || raw.length > MAX_FRAME_BYTES) return;
		let frame: { k?: unknown; d?: unknown; ttl?: unknown };
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof frame.k !== "string" || frame.k === RTC_PRESENCE_KEY) return;
		if (!frame.d || typeof frame.d !== "object" || Array.isArray(frame.d)) return;
		client.receiveEphemeral({
			type: "ephemeral",
			key: frame.k,
			// Identity comes from the server-relayed signaling, not the frame.
			clientId: peer.id,
			userId: peer.userId,
			data: frame.d as Record<string, unknown>,
			...(typeof frame.ttl === "number" ? { ttlMs: frame.ttl } : {}),
		});
	}

	function connectedPeers(): Peer[] {
		const out: Peer[] = [];
		for (const peer of peers.values()) if (peer.state === "connected") out.push(peer);
		return out;
	}

	/** True when every peer the mesh knows of gets frames peer-to-peer. */
	function everyoneDirect(): boolean {
		for (const id of known.keys()) {
			if (peers.get(id)?.state !== "connected") return false;
		}
		return known.size > 0;
	}

	const router: EphemeralRouter = {
		async send(params, viaServer) {
			const route = params.transport ?? "auto";
			if (route === "server" || destroyed) {
				if (route !== "p2p") await viaServer(params);
				return;
			}
			seq = Math.max(seq + 1, Date.now());
			const data = { ...params.data, [EPHEMERAL_SEQ_FIELD]: seq };
			const frame = JSON.stringify({ k: params.key, d: data, ttl: params.ttlMs });
			for (const peer of connectedPeers()) {
				const channel = peer.eph;
				if (channel?.readyState !== "open" || channel.bufferedAmount > MAX_BUFFERED_BYTES) continue;
				try {
					channel.send(frame);
				} catch {
					// A channel closing mid-send; the close handler cleans up.
				}
			}
			if (route === "p2p") return;

			const withSeq = { ...params, data };
			// Throttle the server copy only while everyone known is direct;
			// otherwise a server-only peer would see the reduced rate.
			if (!everyoneDirect()) {
				// A frame parked for the trailing edge is older than this one;
				// sending it later would leave the server on a stale value.
				const parked = trailing.get(params.key);
				if (parked) {
					clearTimeout(parked.timer);
					trailing.delete(params.key);
				}
				lastServerSend.set(params.key, Date.now());
				await viaServer(withSeq);
				return;
			}
			const now = Date.now();
			const last = lastServerSend.get(params.key) ?? 0;
			const pending = trailing.get(params.key);
			if (now - last >= serverIntervalMs && !pending) {
				lastServerSend.set(params.key, now);
				await viaServer(withSeq);
				return;
			}
			// Trailing edge: the newest frame always reaches the server, so the
			// stored state (and a joiner's snapshot) ends on the final value.
			if (pending) {
				pending.params = withSeq;
				return;
			}
			const slot = {
				params: withSeq,
				timer: setTimeout(
					() => {
						trailing.delete(params.key);
						lastServerSend.set(params.key, Date.now());
						void viaServer(slot.params).catch(() => {});
					},
					Math.max(0, serverIntervalMs - (now - last)),
				),
			};
			trailing.set(params.key, slot);
		},
	};
	client.setEphemeralRouter(router);

	// ── Calls ───────────────────────────────────────────────────────────

	function sendControl(peer: Peer, message: ControlMessage): void {
		if (peer.ctl?.readyState !== "open") return;
		try {
			peer.ctl.send(JSON.stringify(message));
		} catch {
			// Closing; the close handler cleans up.
		}
	}

	function receiveControl(peer: Peer, raw: unknown): void {
		if (typeof raw !== "string" || raw.length > MAX_FRAME_BYTES) return;
		let message: ControlMessage;
		try {
			message = JSON.parse(raw) as ControlMessage;
		} catch {
			return;
		}
		switch (message.t) {
			case "call":
				setRemoteCall(peer, message.on === true);
				break;
			case "stream":
				if (
					typeof message.id === "string" &&
					(message.kind === "camera" || message.kind === "screen")
				) {
					peer.streamKinds.set(message.id, message.kind);
					changed();
				}
				break;
			case "unstream":
				if (typeof message.id === "string") {
					peer.streamKinds.delete(message.id);
					peer.remoteStreams.delete(message.id);
					changed();
				}
				break;
			case "mute":
				peer.remoteMuted = { audio: message.audio === true, video: message.video === true };
				changed();
				break;
		}
	}

	function setRemoteCall(peer: Peer, inCall: boolean): void {
		if (peer.remoteCall === inCall) return;
		peer.remoteCall = inCall;
		const info = known.get(peer.id);
		if (info) info.inCall = inCall;
		if (!local || peer.state !== "connected") {
			changed();
			return;
		}
		if (inCall) {
			attachMedia(peer);
		} else {
			// They left: stop spending uplink on someone not watching.
			for (const id of peer.senders.keys()) detachStream(peer, id);
			peer.remoteStreams.clear();
		}
		changed();
	}

	function localStreams(): Array<[MediaStream, StreamKind]> {
		const out: Array<[MediaStream, StreamKind]> = [];
		if (local?.camera) out.push([local.camera, "camera"]);
		if (local?.screen) out.push([local.screen, "screen"]);
		return out;
	}

	function attachStream(peer: Peer, stream: MediaStream, kind: StreamKind): void {
		if (peer.senders.has(stream.id)) return;
		// Label first, so the receiver knows a screen from a camera by the
		// time its track event fires.
		sendControl(peer, { t: "stream", id: stream.id, kind });
		peer.senders.set(
			stream.id,
			stream.getTracks().map((track) => peer.pc.addTrack(track, stream)),
		);
	}

	function detachStream(peer: Peer, streamId: string): void {
		const senders = peer.senders.get(streamId);
		if (!senders) return;
		peer.senders.delete(streamId);
		for (const sender of senders) {
			try {
				peer.pc.removeTrack(sender);
			} catch {
				// Connection already closed.
			}
		}
		sendControl(peer, { t: "unstream", id: streamId });
	}

	function attachMedia(peer: Peer): void {
		for (const [stream, kind] of localStreams()) attachStream(peer, stream, kind);
	}

	function callPeers(): Peer[] {
		return connectedPeers().filter((peer) => peer.remoteCall);
	}

	function isMediaStream(value: unknown): value is MediaStream {
		return typeof (value as MediaStream).getTracks === "function";
	}

	function mediaDevices(): MediaDevices {
		const devices = globalThis.navigator?.mediaDevices;
		if (!devices) throw new Error("reflectdb webrtc: media devices are not available here");
		return devices;
	}

	function stopScreen(): void {
		const screen = local?.screen;
		if (!local || !screen) return;
		local.screen = null;
		for (const track of screen.getTracks()) track.stop();
		for (const peer of peers.values()) detachStream(peer, screen.id);
		changed();
	}

	function leave(): void {
		// Cancels a join still waiting on the camera prompt, too.
		callEpoch++;
		if (!local) return;
		const leaving = local;
		local = null;
		for (const peer of peers.values()) {
			for (const id of peer.senders.keys()) detachStream(peer, id);
			peer.remoteStreams.clear();
			sendControl(peer, { t: "call", on: false });
		}
		for (const stream of [leaving.camera, leaving.screen]) {
			for (const track of stream?.getTracks() ?? []) track.stop();
		}
		announce();
		changed();
	}

	// ── Public API ──────────────────────────────────────────────────────

	const mesh: PeerMesh = {
		get clientId() {
			return self;
		},
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		call(source = { audio: true, video: true }) {
			if (local || destroyed) return Promise.resolve();
			const epoch = callEpoch;
			joining ??= (async () => {
				const camera = isMediaStream(source) ? source : await mediaDevices().getUserMedia(source);
				if (destroyed || local || epoch !== callEpoch) {
					// Destroyed or left meanwhile: release the device rather than leave its light on.
					if (camera !== source) for (const track of camera.getTracks()) track.stop();
					return;
				}
				local = { camera, screen: null, audioMuted: false, videoMuted: false };
				for (const peer of connectedPeers()) {
					sendControl(peer, { t: "call", on: true });
					if (peer.remoteCall) attachMedia(peer);
				}
				announce();
				changed();
			})().finally(() => {
				joining = null;
			});
			return joining;
		},

		shareScreen(source) {
			if (!local || local.screen) return Promise.resolve();
			const call = local;
			sharing ??= (async () => {
				const screen =
					source ?? (await mediaDevices().getDisplayMedia({ video: true, audio: false }));
				if (local !== call || call.screen) {
					// Left (or rejoined) while the picker was open.
					if (screen !== source) for (const track of screen.getTracks()) track.stop();
					return;
				}
				call.screen = screen;
				// The browser's own "Stop sharing" button ends the track.
				for (const track of screen.getTracks()) track.onended = stopScreen;
				for (const peer of callPeers()) attachStream(peer, screen, "screen");
				changed();
			})().finally(() => {
				sharing = null;
			});
			return sharing;
		},

		stopScreen,

		setMuted(muted) {
			if (!local) return;
			if (muted.audio !== undefined) local.audioMuted = muted.audio;
			if (muted.video !== undefined) local.videoMuted = muted.video;
			for (const track of local.camera?.getAudioTracks() ?? []) track.enabled = !local.audioMuted;
			for (const track of local.camera?.getVideoTracks() ?? []) track.enabled = !local.videoMuted;
			for (const peer of connectedPeers()) {
				sendControl(peer, { t: "mute", audio: local.audioMuted, video: local.videoMuted });
			}
			changed();
		},

		leave,

		destroy() {
			if (destroyed) return;
			leave();
			destroyed = true;
			clearInterval(announceTimer);
			for (const slot of trailing.values()) clearTimeout(slot.timer);
			trailing.clear();
			unsubPresence();
			unsubSignal();
			unsubState();
			globalThis.removeEventListener?.("pagehide", onPageHide);
			client.setEphemeralRouter(null);
			for (const peer of peers.values()) closePeer(peer);
			known.clear();
			changed();
		},
	};
	return mesh;
}
