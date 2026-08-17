import type {
	ClientMessage,
	ClientTransport,
	ServerMessage,
	ServerTransport,
} from "../core/types.ts";
import { TransportSendError } from "../core/types.ts";

// ── Server-side WebSocket Transport ─────────────────────────────────────────

/**
 * Hand `data` to the socket, throwing `TransportSendError` if it could not be
 * queued. Callers MUST propagate the failure: the broadcast engine only commits
 * a client's result cache once every send for that delta resolved, so a
 * swallowed failure permanently strands rows on that client.
 *
 * `maxBufferedBytes` is outbound backpressure — a client that stops reading
 * would otherwise let the kernel/socket buffer grow without bound.
 */
function trySend(clientId: string, ws: WebSocketLike, data: string, maxBufferedBytes: number): void {
	const sock = ws as WebSocketLike & { readyState?: number; bufferedAmount?: number };
	const rs = sock.readyState;
	// 1 = OPEN per spec. CONNECTING/CLOSING/CLOSED cannot deliver.
	if (rs !== undefined && rs !== 1) {
		throw new TransportSendError(clientId, `ws not open (readyState=${rs})`);
	}
	if (maxBufferedBytes > 0 && (sock.bufferedAmount ?? 0) > maxBufferedBytes) {
		throw new TransportSendError(
			clientId,
			`ws outbound buffer over limit (${sock.bufferedAmount} > ${maxBufferedBytes})`,
		);
	}
	try {
		ws.send(data);
	} catch (err) {
		throw new TransportSendError(
			clientId,
			`ws send failed: ${err instanceof Error ? err.message : String(err)}`,
			err,
		);
	}
}

export interface WsServerConfig {
	server: {
		upgrade(req: Request, options: { data: { clientId: string } }): boolean;
	};
	path?: string;
}

export interface WsServerTransportConfig {
	/** Max inbound message bytes before the connection is closed. Default: 1 MB. */
	maxMessageBytes?: number;
	/** Ping interval in ms. 0 disables. Default: 30_000. */
	pingIntervalMs?: number;
	/** Close a connection if no pong is seen in this window. Default: 2× pingInterval. */
	pongTimeoutMs?: number;
	/**
	 * Outbound backpressure ceiling. When the socket's `bufferedAmount` exceeds
	 * this, `send` rejects instead of queueing more — a slow reader can't make
	 * the server buffer without bound. 0 disables. Default: 8 MB.
	 */
	maxBufferedBytes?: number;
}

/**
 * Origin-check helper for WS/SSE/polling upgrade paths. Callers invoke this
 * before accepting a connection. The default browser WebSocket/EventSource
 * clients always send an Origin header, so a `null` return usually means
 * a non-browser peer — treat accordingly for your threat model.
 *
 *   if (!isOriginAllowed(req, ["https://app.example.com"])) return new Response("Forbidden", { status: 403 });
 */
export function isOriginAllowed(
	req: Request,
	allowed: readonly string[] | ((origin: string | null) => boolean),
): boolean {
	const origin = req.headers.get("origin");
	if (typeof allowed === "function") return allowed(origin);
	if (allowed.includes("*")) return true;
	if (!origin) return false;
	return allowed.includes(origin);
}

export function createWsServerTransport(
	cfg: WsServerTransportConfig = {},
): ServerTransport & {
	handleOpen(clientId: string, ws: WebSocketLike): void;
	handleMessage(clientId: string, data: string): void;
	handleClose(clientId: string): void;
	handlePong(clientId: string): void;
} {
	const clients = new Map<string, WebSocketLike>();
	const rooms = new Map<string, Set<string>>();
	const lastSeen = new Map<string, number>();
	const maxMessageBytes = cfg.maxMessageBytes ?? 1_000_000;
	const pingIntervalMs = cfg.pingIntervalMs ?? 30_000;
	const pongTimeoutMs = cfg.pongTimeoutMs ?? pingIntervalMs * 2;
	const maxBufferedBytes = cfg.maxBufferedBytes ?? 8_000_000;

	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	if (pingIntervalMs > 0) {
		heartbeatTimer = setInterval(() => {
			const now = Date.now();
			for (const [clientId, ws] of clients) {
				const last = lastSeen.get(clientId) ?? now;
				if (now - last > pongTimeoutMs) {
					// Half-open TCP — close and let the client reconnect.
					try {
						ws.close();
					} catch {
						// already closed
					}
					continue;
				}
				try {
					(ws as WebSocketLike & { ping?: () => void }).ping?.();
				} catch {
					// not supported on this socket
				}
			}
		}, pingIntervalMs);
		if (typeof (heartbeatTimer as unknown as { unref?: () => void }).unref === "function") {
			(heartbeatTimer as unknown as { unref: () => void }).unref();
		}
	}
	let messageHandler: ((clientId: string, message: ClientMessage) => void) | null = null;
	let connectHandler: ((clientId: string, req: Request) => void) | null = null;
	let disconnectHandler: ((clientId: string) => void) | null = null;

	return {
		handleOpen(clientId: string, ws: WebSocketLike): void {
			clients.set(clientId, ws);
			lastSeen.set(clientId, Date.now());
			connectHandler?.(clientId, new Request("https://ws-connect"));
		},

		handleMessage(clientId: string, data: string): void {
			lastSeen.set(clientId, Date.now());
			// Measure UTF-8 bytes, not JS chars (which are UTF-16 code units —
			// a 4-byte UTF-8 char counts as 1 here, letting a malicious client
			// pack 4× the cap past a char-count gate).
			const byteLen =
				typeof Buffer !== "undefined"
					? Buffer.byteLength(data, "utf8")
					: new Blob([data]).size;
			if (byteLen > maxMessageBytes) {
				console.warn(
					`[reflectdb] WS server: message from ${clientId} exceeds ${maxMessageBytes} bytes (${byteLen}), closing`,
				);
				const ws = clients.get(clientId);
				try {
					ws?.close();
				} catch {
					// already closed
				}
				return;
			}
			try {
				const message = JSON.parse(data) as ClientMessage;
				messageHandler?.(clientId, message);
			} catch (err) {
				console.warn(
					`[reflectdb] WS server: malformed message from ${clientId}:`,
					err instanceof Error ? err.message : String(err),
				);
			}
		},

		handleClose(clientId: string): void {
			clients.delete(clientId);
			lastSeen.delete(clientId);
			// Remove from all rooms
			for (const members of rooms.values()) {
				members.delete(clientId);
			}
			disconnectHandler?.(clientId);
		},

		handlePong(clientId: string): void {
			lastSeen.set(clientId, Date.now());
		},

		async send(clientId: string, message: ServerMessage): Promise<void> {
			const ws = clients.get(clientId);
			if (!ws) {
				throw new TransportSendError(clientId, "no socket registered for client");
			}
			trySend(clientId, ws, JSON.stringify(message), maxBufferedBytes);
		},

		async broadcast(roomId: string, message: ServerMessage, exclude?: string): Promise<void> {
			const members = rooms.get(roomId);
			if (!members) return;

			const data = JSON.stringify(message);
			// Room broadcast is fan-out, not per-client delivery accounting: one
			// dead socket must not abort the rest. Failures are logged, not thrown
			// (unlike `send`, whose result gates a result-cache commit).
			for (const clientId of members) {
				if (clientId === exclude) continue;
				const ws = clients.get(clientId);
				if (!ws) continue;
				try {
					trySend(clientId, ws, data, maxBufferedBytes);
				} catch (err) {
					console.warn(
						"[reflectdb] ws broadcast skipped a client:",
						err instanceof Error ? err.message : err,
					);
				}
			}
		},

		disconnect(clientId: string): void {
			const ws = clients.get(clientId);
			if (!ws) return;
			try {
				ws.close();
			} catch {
				// already closed
			}
			clients.delete(clientId);
		},

		onMessage(handler: (clientId: string, message: ClientMessage) => void): void {
			messageHandler = handler;
		},

		onConnect(handler: (clientId: string, req: Request) => void): void {
			connectHandler = handler;
		},

		onDisconnect(handler: (clientId: string) => void): void {
			disconnectHandler = handler;
		},

		async close(): Promise<void> {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			for (const ws of clients.values()) {
				ws.close();
			}
			clients.clear();
			lastSeen.clear();
			rooms.clear();
		},
	};
}

// ── Client-side WebSocket Transport ─────────────────────────────────────────

export interface WsClientConfig {
	url: string;
	protocols?: string[];
}

export function createWsClientTransport(config: WsClientConfig): ClientTransport & {
	getSocket(): WebSocket | null;
} {
	let ws: WebSocket | null = null;
	let handler: ((message: ServerMessage) => void) | null = null;
	let intentionalClose = false;
	const pending: string[] = [];
	// Bound the pending queue so an offline client can't grow it without limit.
	// SyncClient's reconnect logic re-pushes pending ops anyway, so dropping
	// stale queued frames here is safe.
	const MAX_PENDING = 1000;

	function connect(): WebSocket {
		const socket = new WebSocket(config.url, config.protocols);

		socket.addEventListener("open", () => {
			// Flush any pending messages
			for (const msg of pending) {
				socket.send(msg);
			}
			pending.length = 0;
		});

		socket.addEventListener("message", (event) => {
			try {
				const message = JSON.parse(event.data as string) as ServerMessage;
				handler?.(message);
			} catch (err) {
				console.warn(
					"[reflectdb] WS client: malformed message ignored:",
					err instanceof Error ? err.message : String(err),
				);
			}
		});

		socket.addEventListener("close", () => {
			if (ws === socket) ws = null;
			if (!intentionalClose) {
				handler?.({ type: "disconnect", reason: "ws_closed" } as ServerMessage);
			}
		});

		socket.addEventListener("error", () => {
			// Don't null `ws` here — error often precedes close which handles it.
			// Clearing twice would race with concurrent send() seeing fresh ws.
			if (!intentionalClose) {
				handler?.({ type: "disconnect", reason: "ws_error" } as ServerMessage);
			}
		});

		return socket;
	}

	return {
		async send(message: ClientMessage): Promise<void> {
			if (!ws) {
				ws = connect();
			}

			const data = JSON.stringify(message);
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(data);
			} else {
				pending.push(data);
				while (pending.length > MAX_PENDING) pending.shift();
			}
		},

		subscribe(h: (message: ServerMessage) => void): void {
			handler = h;
			if (!ws) {
				ws = connect();
			}
		},

		async close(): Promise<void> {
			intentionalClose = true;
			if (ws) {
				ws.close();
				ws = null;
			}
		},

		getSocket(): WebSocket | null {
			return ws;
		},
	};
}

// ── Minimal WebSocket interface for server-side use ─────────────────────────

export interface WebSocketLike {
	send(data: string): void;
	close(): void;
	/** WebSocket readyState. When present, only 1 (OPEN) accepts sends. */
	readyState?: number;
	/** Bytes queued but not yet flushed. Used for outbound backpressure. */
	bufferedAmount?: number;
}
