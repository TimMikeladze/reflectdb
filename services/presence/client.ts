/**
 * Browser client for the presence service.
 *
 * No dependencies, no build step needed — it speaks the protocol in
 * `protocol.ts` over an `EventSource` for what it receives and `fetch` for what
 * it sends, keeps a peer map per channel, and reconnects with backoff. Usable
 * on its own by apps that never touch reflectdb sync.
 *
 * Two things about it are consequences of running on a platform with no
 * sockets, and both are load-bearing:
 *
 *   - **The client owns its id.** A stream is a request, and requests end. The
 *     server recycles one about every minute, so an id assigned per stream
 *     would make every peer watch you leave and rejoin all day. The id is
 *     minted here and kept for the tab.
 *   - **Leaving is announced, not detected.** Closing a socket told the server
 *     you were gone. Closing a tab tells it nothing, so the client sends a
 *     leave beacon on the way out and the server's TTL covers the times that
 *     beacon does not make it.
 */

import {
	PRESENCE_PROTOCOL_VERSION,
	type ErrorFrame,
	type PeerState,
	type ServerFrame,
} from "./protocol.js";

export interface Peer<T = Record<string, unknown>> {
	clientId: string;
	data: T;
	identity?: Record<string, unknown>;
}

export type ConnectionState = "connecting" | "connected" | "closed";

export interface PresenceClientConfig {
	/**
	 * Base URL of the service, without a trailing path — the client appends
	 * `/stream`, `/publish` and `/leave`. e.g. `https://reflectdb.dev/api/presence`
	 */
	url: string;
	apiKey: string;
	room: string;
	/** Shown to peers on every event this connection publishes. */
	identity?: Record<string, unknown>;
	/** Default TTL for published state. Server clamps it. */
	ttlMs?: number;
	/**
	 * Override the per-tab client id. Supply one only if the app already has a
	 * stable per-tab identity; otherwise the client mints and remembers one.
	 */
	clientId?: string;
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
	get clientId(): string;
	close(): void;
}

/** Where a tab's id is remembered, so a reload inside one tab keeps it. */
const STORAGE_PREFIX = "reflectdb-presence:";

function mintClientId(room: string): string {
	const key = `${STORAGE_PREFIX}${room}`;
	try {
		const stored = sessionStorage.getItem(key);
		if (stored) return stored;
	} catch {
		// Private mode, or storage disabled. A fresh id per load is a worse
		// experience than a stable one, not a broken one.
	}
	const id =
		typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID()
			: `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
	try {
		sessionStorage.setItem(key, id);
	} catch {
		// See above.
	}
	return id;
}

export function createPresenceClient(config: PresenceClientConfig): PresenceClient {
	const base = config.url.replace(/\/+$/, "");
	const maxBackoff = config.maxBackoffMs ?? 10_000;
	const clientId = config.clientId ?? mintClientId(config.room);

	let source: EventSource | null = null;
	let state: ConnectionState = "connecting";
	let attempt = 0;
	let closed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Set when the server says it is recycling the stream. A scheduled close is
	 * not an outage, so it must not be paid for with a backoff — without this,
	 * a healthy page would stutter once a minute forever.
	 */
	let recycling = false;

	/** channel → clientId → peer */
	const peersByChannel = new Map<string, Map<string, Peer>>();
	const listeners = new Map<string, Set<(peers: Peer[]) => void>>();
	/** Last published state per channel, replayed after a reconnect. */
	const published = new Map<string, { data: Record<string, unknown>; ttlMs?: number }>();
	/**
	 * One request in flight per channel, with at most one queued behind it.
	 * A cursor publishes many times a second; without this a slow network turns
	 * that into an unbounded queue of stale positions nobody wants delivered.
	 */
	const inFlight = new Set<string>();
	const queued = new Map<string, { data: Record<string, unknown>; ttlMs?: number }>();

	function setState(next: ConnectionState): void {
		if (state === next) return;
		state = next;
		config.onStateChange?.(next);
	}

	function notify(channel: string): void {
		const set = listeners.get(channel);
		if (!set) return;
		const snapshot = [...(peersByChannel.get(channel)?.values() ?? [])];
		for (const listener of set) listener(snapshot);
	}

	function applyPeer(peer: PeerState): void {
		if (peer.clientId === clientId) return;
		const map = peersByChannel.get(peer.channel) ?? new Map<string, Peer>();
		map.set(peer.clientId, {
			clientId: peer.clientId,
			data: peer.data,
			identity: peer.identity,
		});
		peersByChannel.set(peer.channel, map);
	}

	function dropPeer(peerId: string, channel?: string): string[] {
		const touched: string[] = [];
		for (const [name, map] of peersByChannel) {
			if (channel !== undefined && name !== channel) continue;
			if (map.delete(peerId)) touched.push(name);
		}
		return touched;
	}

	// ── Sending ───────────────────────────────────────────────────────────

	async function post(path: string, body: Record<string, unknown>): Promise<Response | null> {
		try {
			return await fetch(`${base}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				// Presence is disposable; a stale retry is worse than a miss.
				cache: "no-store",
				keepalive: true,
			});
		} catch {
			// Offline, or the page is going away. The next publish or the TTL
			// settles it either way.
			return null;
		}
	}

	function fail(response: Response): void {
		if (response.status === 401 || response.status === 403) {
			closed = true;
			setState("closed");
			config.onError?.({
				type: "error",
				code: "unauthorized",
				message: "unknown API key",
				fatal: true,
			});
			source?.close();
			source = null;
			return;
		}
		if (response.status === 409) {
			config.onError?.({
				type: "error",
				code: "room_full",
				message: "room is at its entry limit",
				fatal: false,
			});
		}
		// 429 is ordinary for a cursor: the server enforces a minimum gap
		// between writes and the next publish is milliseconds away. Reporting
		// it would be noise, not information.
	}

	function send(channel: string, data: Record<string, unknown>, ttlMs?: number): void {
		if (closed) return;
		if (inFlight.has(channel)) {
			queued.set(channel, { data, ttlMs });
			return;
		}
		inFlight.add(channel);
		void post("/publish", {
			apiKey: config.apiKey,
			room: config.room,
			clientId,
			channel,
			data,
			identity: config.identity,
			ttlMs: ttlMs ?? config.ttlMs,
		}).then((response) => {
			inFlight.delete(channel);
			if (response && !response.ok) fail(response);
			const next = queued.get(channel);
			if (next) {
				queued.delete(channel);
				send(channel, next.data, next.ttlMs);
			}
		});
	}

	// ── Receiving ─────────────────────────────────────────────────────────

	function handle(frame: ServerFrame): void {
		switch (frame.type) {
			case "welcome": {
				if (frame.protocolVersion !== PRESENCE_PROTOCOL_VERSION) {
					closed = true;
					setState("closed");
					config.onError?.({
						type: "error",
						code: "protocol_version",
						message: `server speaks protocol ${frame.protocolVersion}, client speaks ${PRESENCE_PROTOCOL_VERSION}`,
						fatal: true,
					});
					source?.close();
					source = null;
					return;
				}
				attempt = 0;
				setState("connected");
				// State may have expired while the client was away, so replay
				// rather than trust that the server still holds it.
				for (const [channel, entry] of published) send(channel, entry.data, entry.ttlMs);
				return;
			}
			case "snapshot": {
				// Authoritative for the room: anything absent here is gone,
				// including peers who left while this client was reconnecting.
				const touched = new Set(peersByChannel.keys());
				peersByChannel.clear();
				for (const peer of frame.peers) {
					applyPeer(peer);
					touched.add(peer.channel);
				}
				for (const channel of touched) notify(channel);
				return;
			}
			case "presence":
				applyPeer(frame);
				notify(frame.channel);
				return;
			case "leave":
				for (const channel of dropPeer(frame.clientId, frame.channel)) notify(channel);
				return;
			case "bye":
				recycling = true;
				return;
			case "error":
				config.onError?.(frame);
				if (frame.fatal) {
					closed = true;
					setState("closed");
					source?.close();
					source = null;
				}
				return;
		}
	}

	function connect(): void {
		if (closed) return;
		setState("connecting");

		const url = new URL(`${base}/stream`, globalThis.location?.href ?? "http://localhost");
		url.searchParams.set("apiKey", config.apiKey);
		url.searchParams.set("room", config.room);
		url.searchParams.set("clientId", clientId);

		const es = new EventSource(url.toString());
		source = es;

		es.onmessage = (event) => {
			let frame: ServerFrame;
			try {
				frame = JSON.parse(event.data) as ServerFrame;
			} catch {
				// A malformed frame must not take the stream down.
				return;
			}
			handle(frame);
		};

		es.onerror = () => {
			// Own the reconnect rather than let `EventSource` do it: its
			// built-in retry has no ceiling awareness and would hammer a
			// service that is actually down.
			es.close();
			if (source === es) source = null;
			if (closed) return;

			if (recycling) {
				// The server closed on schedule. Reopen at once — there was no
				// failure to back off from.
				recycling = false;
				attempt = 0;
				connect();
				return;
			}

			setState("connecting");
			const delay = Math.min(maxBackoff, 500 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
			attempt++;
			reconnectTimer = setTimeout(connect, delay);
		};
	}

	// ── Leaving ───────────────────────────────────────────────────────────

	function beacon(channel?: string): void {
		const body = JSON.stringify({
			apiKey: config.apiKey,
			room: config.room,
			clientId,
			channel,
		});
		// `sendBeacon` is the only send that survives a page teardown. It posts
		// as `text/plain`, which is why the leave handler accepts that type.
		if (typeof navigator !== "undefined" && navigator.sendBeacon) {
			try {
				navigator.sendBeacon(`${base}/leave`, new Blob([body], { type: "text/plain" }));
				return;
			} catch {
				// Fall through to fetch.
			}
		}
		void post("/leave", JSON.parse(body) as Record<string, unknown>);
	}

	if (typeof window !== "undefined") {
		// `pagehide` fires on close and on entry to the back/forward cache
		// alike. Announcing the leave in both cases is right — a backgrounded
		// page should not hold a cursor on the board — and `pageshow` puts the
		// state back if the page is restored.
		window.addEventListener("pagehide", () => {
			if (!closed) beacon();
		});
		window.addEventListener("pageshow", (event) => {
			if (closed || !(event as PageTransitionEvent).persisted) return;
			for (const [channel, entry] of published) send(channel, entry.data, entry.ttlMs);
			if (!source) connect();
		});
	}

	connect();

	return {
		publish(channel: string, data: Record<string, unknown>, ttlMs?: number): void {
			published.set(channel, { data, ttlMs });
			send(channel, data, ttlMs);
		},

		clear(channel: string): void {
			published.delete(channel);
			queued.delete(channel);
			if (closed) return;
			void post("/leave", {
				apiKey: config.apiKey,
				room: config.room,
				clientId,
				channel,
			});
		},

		subscribe<T = Record<string, unknown>>(
			channel: string,
			listener: (peers: Peer<T>[]) => void,
		): () => void {
			const set = listeners.get(channel) ?? new Set<(peers: Peer[]) => void>();
			set.add(listener as (peers: Peer[]) => void);
			listeners.set(channel, set);
			listener([...(peersByChannel.get(channel)?.values() ?? [])] as Peer<T>[]);
			return () => {
				set.delete(listener as (peers: Peer[]) => void);
			};
		},

		peers<T = Record<string, unknown>>(channel: string): Peer<T>[] {
			return [...(peersByChannel.get(channel)?.values() ?? [])] as Peer<T>[];
		},

		get state(): ConnectionState {
			return state;
		},

		get clientId(): string {
			return clientId;
		},

		close(): void {
			closed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = null;
			source?.close();
			source = null;
			setState("closed");
			beacon();
		},
	};
}
