/**
 * Browser client for the presence service.
 *
 * No dependencies, no build step needed — it speaks the protocol in
 * `protocol.ts` over a plain WebSocket, keeps a peer map per channel, and
 * reconnects with backoff. Usable on its own by apps that never touch
 * reflectdb sync.
 */

import {
	PRESENCE_PROTOCOL_VERSION,
	type ErrorFrame,
	type ServerFrame,
} from "./protocol.ts";

export interface Peer<T = Record<string, unknown>> {
	clientId: string;
	data: T;
	identity?: Record<string, unknown>;
}

export type ConnectionState = "connecting" | "connected" | "closed";

export interface PresenceClientConfig {
	/** e.g. `wss://reflectdb-presence.fly.dev/connect` */
	url: string;
	apiKey: string;
	room: string;
	/** Shown to peers on every event this connection publishes. */
	identity?: Record<string, unknown>;
	/** Default TTL for published state. Server clamps it. */
	ttlMs?: number;
	/** Reconnect backoff ceiling. Default 10s. */
	maxBackoffMs?: number;
	onError?: (error: ErrorFrame) => void;
	onStateChange?: (state: ConnectionState) => void;
}

export interface PresenceClient {
	/** Publish this connection's state on a channel. */
	publish(channel: string, data: Record<string, unknown>, ttlMs?: number): void;
	/** Drop this connection's state on a channel. */
	clear(channel: string): void;
	/** Observe peers on a channel. Fires immediately with what is already known. */
	subscribe<T = Record<string, unknown>>(
		channel: string,
		listener: (peers: Peer<T>[]) => void,
	): () => void;
	/** Peers currently known on a channel, excluding this connection. */
	peers<T = Record<string, unknown>>(channel: string): Peer<T>[];
	get state(): ConnectionState;
	get clientId(): string | null;
	close(): void;
}

export function createPresenceClient(config: PresenceClientConfig): PresenceClient {
	const maxBackoff = config.maxBackoffMs ?? 10_000;

	let socket: WebSocket | null = null;
	let state: ConnectionState = "connecting";
	let clientId: string | null = null;
	let attempt = 0;
	let closed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	/** channel → clientId → peer */
	const peersByChannel = new Map<string, Map<string, Peer>>();
	const listeners = new Map<string, Set<(peers: Peer[]) => void>>();
	/** Last published state per channel, replayed after a reconnect. */
	const published = new Map<string, { data: Record<string, unknown>; ttlMs?: number }>();
	const outbox: string[] = [];

	function setState(next: ConnectionState): void {
		if (state === next) return;
		state = next;
		config.onStateChange?.(next);
	}

	function notify(channel: string): void {
		const channelListeners = listeners.get(channel);
		if (!channelListeners) return;
		const snapshot = [...(peersByChannel.get(channel)?.values() ?? [])];
		for (const listener of channelListeners) listener(snapshot);
	}

	function upsertPeer(channel: string, peer: Peer): void {
		const map = peersByChannel.get(channel) ?? new Map<string, Peer>();
		map.set(peer.clientId, peer);
		peersByChannel.set(channel, map);
		notify(channel);
	}

	function dropPeer(peerId: string, channel?: string): void {
		if (channel) {
			peersByChannel.get(channel)?.delete(peerId);
			notify(channel);
			return;
		}
		// No channel means the peer left the room entirely.
		for (const [name, map] of peersByChannel) {
			if (map.delete(peerId)) notify(name);
		}
	}

	function send(payload: string): void {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(payload);
			return;
		}
		// Queue rather than drop: a cursor move during a reconnect should land
		// once the socket is back, not vanish.
		outbox.push(payload);
		if (outbox.length > 64) outbox.shift();
	}

	function handleFrame(frame: ServerFrame): void {
		switch (frame.type) {
			case "welcome":
				clientId = frame.clientId;
				attempt = 0;
				setState("connected");
				// Re-publish what this client had, so peers rebuild its cursor.
				for (const [channel, entry] of published) {
					send(
						JSON.stringify({
							type: "publish",
							channel,
							data: entry.data,
							ttlMs: entry.ttlMs ?? config.ttlMs,
						}),
					);
				}
				return;
			case "snapshot": {
				// A snapshot is authoritative for the room at join time; anything
				// held from a previous connection is stale.
				peersByChannel.clear();
				for (const peer of frame.peers) {
					const map = peersByChannel.get(peer.channel) ?? new Map<string, Peer>();
					map.set(peer.clientId, {
						clientId: peer.clientId,
						data: peer.data,
						identity: peer.identity,
					});
					peersByChannel.set(peer.channel, map);
				}
				for (const channel of listeners.keys()) notify(channel);
				return;
			}
			case "presence":
				upsertPeer(frame.channel, {
					clientId: frame.clientId,
					data: frame.data,
					identity: frame.identity,
				});
				return;
			case "leave":
				dropPeer(frame.clientId, frame.channel);
				return;
			case "error":
				config.onError?.(frame);
				// A fatal error means the server is closing; reconnecting with the
				// same bad key or version would just loop.
				if (frame.fatal) closed = true;
				return;
			case "pong":
				return;
		}
	}

	function connect(): void {
		if (closed) return;
		setState("connecting");
		socket = new WebSocket(config.url);

		socket.addEventListener("open", () => {
			socket?.send(
				JSON.stringify({
					type: "hello",
					protocolVersion: PRESENCE_PROTOCOL_VERSION,
					apiKey: config.apiKey,
					room: config.room,
					identity: config.identity,
				}),
			);
			const queued = outbox.splice(0, outbox.length);
			for (const payload of queued) socket?.send(payload);
		});

		socket.addEventListener("message", (event) => {
			let frame: ServerFrame;
			try {
				frame = JSON.parse(String(event.data)) as ServerFrame;
			} catch {
				return;
			}
			handleFrame(frame);
		});

		socket.addEventListener("close", () => {
			socket = null;
			clientId = null;
			peersByChannel.clear();
			for (const channel of listeners.keys()) notify(channel);
			if (closed) {
				setState("closed");
				return;
			}
			setState("connecting");
			const delay = Math.min(maxBackoff, 250 * 2 ** attempt++);
			reconnectTimer = setTimeout(connect, delay);
		});

		socket.addEventListener("error", () => {
			// `close` always follows; reconnect is scheduled there so the two
			// paths cannot both schedule a timer.
		});
	}

	connect();

	return {
		publish(channel, data, ttlMs) {
			published.set(channel, { data, ttlMs });
			send(JSON.stringify({ type: "publish", channel, data, ttlMs: ttlMs ?? config.ttlMs }));
		},

		clear(channel) {
			published.delete(channel);
			send(JSON.stringify({ type: "clear", channel }));
		},

		subscribe<T = Record<string, unknown>>(
			channel: string,
			listener: (peers: Peer<T>[]) => void,
		): () => void {
			const typed = listener as unknown as (peers: Peer[]) => void;
			const set = listeners.get(channel) ?? new Set<(peers: Peer[]) => void>();
			set.add(typed);
			listeners.set(channel, set);
			listener([...(peersByChannel.get(channel)?.values() ?? [])] as Peer<T>[]);
			return () => {
				set.delete(typed);
				if (set.size === 0) listeners.delete(channel);
			};
		},

		peers<T = Record<string, unknown>>(channel: string): Peer<T>[] {
			return [...(peersByChannel.get(channel)?.values() ?? [])] as Peer<T>[];
		},

		get state() {
			return state;
		},

		get clientId() {
			return clientId;
		},

		close() {
			closed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = null;
			socket?.close();
			socket = null;
			setState("closed");
		},
	};
}
