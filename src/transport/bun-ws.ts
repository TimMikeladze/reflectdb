import type {
	ClientMessage,
	ServerMessage,
	ServerTransport,
} from "../core/types.ts";
import { TransportSendError } from "../core/types.ts";

// ── Server-side Bun WebSocket Transport ────────────────────────────────────

/**
 * Hand `data` to the socket or throw `TransportSendError`. The broadcast engine
 * commits a client's result cache only after its sends resolve, so a swallowed
 * failure permanently strands rows on that client.
 */
function trySend(
	clientId: string,
	ws: { send(d: string): unknown; readyState?: number; getBufferedAmount?: () => number },
	data: string,
	maxBufferedBytes: number,
): void {
	if (ws.readyState !== undefined && ws.readyState !== 1) {
		throw new TransportSendError(clientId, `bun-ws not open (readyState=${ws.readyState})`);
	}
	if (maxBufferedBytes > 0 && typeof ws.getBufferedAmount === "function") {
		const buffered = ws.getBufferedAmount();
		if (buffered > maxBufferedBytes) {
			throw new TransportSendError(
				clientId,
				`bun-ws outbound buffer over limit (${buffered} > ${maxBufferedBytes})`,
			);
		}
	}
	try {
		ws.send(data);
	} catch (err) {
		throw new TransportSendError(
			clientId,
			`bun-ws send failed: ${err instanceof Error ? err.message : String(err)}`,
			err,
		);
	}
}
//
// Factory that returns a ServerTransport and a Bun-compatible websocket
// handlers object. Eliminates the ~30-line boilerplate that every WS
// example previously copy-pasted.
//
// Usage:
//   const { transport, websocket } = createBunWsServerTransport();
//
//   serve({
//     port: 3000,
//     websocket,
//     fetch(req, srv) {
//       if (new URL(req.url).pathname === "/sync") {
//         const id = `ws-${Math.random().toString(36).slice(2, 8)}`;
//         if (srv.upgrade(req, { data: { id, req } })) return;
//       }
//       return new Response("Hello");
//     },
//   });

export interface BunWsTransportData {
	id: string;
	/** Original upgrade request — forwarded to the onConnect handler if provided */
	req?: Request;
}

/** Bun's ServerWebSocket shape (subset used by this transport) */
interface BunServerWebSocket<T> {
	data: T;
	send(data: string): void;
	ping?: (data?: string) => void;
	close(): void;
	readyState?: number;
	/** Bun exposes queued-but-unflushed bytes here; used for backpressure. */
	getBufferedAmount?: () => number;
}

export interface BunWsServerConfig {
	/** Max inbound message bytes before the connection is closed. Default: 1 MB. */
	maxMessageBytes?: number;
	/** Ping interval in ms. 0 disables. Default: 30_000. */
	pingIntervalMs?: number;
	/** Close a connection if no message/pong seen in this window. Default: 2× pingInterval. */
	pongTimeoutMs?: number;
	/**
	 * Outbound backpressure ceiling in bytes. `send` rejects once the socket has
	 * more than this queued, so a slow reader can't grow server memory without
	 * bound. 0 disables. Default: 8 MB.
	 */
	maxBufferedBytes?: number;
}

export function createBunWsServerTransport(cfg: BunWsServerConfig = {}): {
	transport: ServerTransport;
	websocket: {
		open(ws: BunServerWebSocket<BunWsTransportData>): void;
		// `Uint8Array`, not `Buffer`: this signature is emitted into
		// dist/transport/bun-ws.d.ts, and naming a Node global there breaks every
		// consumer type-checking without @types/node. Bun passes a Buffer, which
		// is a Uint8Array. `bun run verify:node` guards the regression.
		message(ws: BunServerWebSocket<BunWsTransportData>, data: string | Uint8Array): void;
		close(ws: BunServerWebSocket<BunWsTransportData>): void;
		pong?(ws: BunServerWebSocket<BunWsTransportData>): void;
	};
} {
	const clients = new Map<string, BunServerWebSocket<BunWsTransportData>>();
	const lastSeen = new Map<string, number>();
	const maxMessageBytes = cfg.maxMessageBytes ?? 1_000_000;
	const pingIntervalMs = cfg.pingIntervalMs ?? 30_000;
	const pongTimeoutMs = cfg.pongTimeoutMs ?? pingIntervalMs * 2;
	const maxBufferedBytes = cfg.maxBufferedBytes ?? 8_000_000;
	let messageHandler: ((clientId: string, message: ClientMessage) => void) | null = null;
	let connectHandler: ((clientId: string, req: Request) => void) | null = null;
	let disconnectHandler: ((clientId: string) => void) | null = null;

	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	if (pingIntervalMs > 0) {
		heartbeatTimer = setInterval(() => {
			const now = Date.now();
			for (const [id, ws] of clients) {
				const last = lastSeen.get(id) ?? now;
				if (now - last > pongTimeoutMs) {
					try {
						ws.close();
					} catch {
						// already closed
					}
					continue;
				}
				try {
					ws.ping?.();
				} catch {
					// not supported
				}
			}
		}, pingIntervalMs);
		if (typeof (heartbeatTimer as unknown as { unref?: () => void }).unref === "function") {
			(heartbeatTimer as unknown as { unref: () => void }).unref();
		}
	}

	const websocket = {
		open(ws: BunServerWebSocket<BunWsTransportData>): void {
			const { id, req } = ws.data;
			clients.set(id, ws);
			lastSeen.set(id, Date.now());
			connectHandler?.(id, req ?? new Request("https://ws-connect"));
		},
		message(ws: BunServerWebSocket<BunWsTransportData>, data: string | Uint8Array): void {
			const { id } = ws.data;
			lastSeen.set(id, Date.now());
			// Check UTF-8 byte length before stringifying. JS char count
			// (UTF-16 code units) under-counts multi-byte chars by up to 4×.
			const byteLen =
				typeof data === "string"
					? typeof Buffer !== "undefined"
						? Buffer.byteLength(data, "utf8")
						: new Blob([data]).size
					: data.length;
			if (byteLen > maxMessageBytes) {
				console.warn(
					`[reflectdb] bun-ws: message from ${id} exceeds ${maxMessageBytes} bytes (${byteLen}), closing`,
				);
				try {
					ws.close();
				} catch {
					// already closed
				}
				return;
			}
			const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
			try {
				messageHandler?.(id, JSON.parse(raw));
			} catch (err) {
				console.warn(
					`[reflectdb] bun-ws: malformed message from ${id}:`,
					err instanceof Error ? err.message : String(err),
				);
			}
		},
		close(ws: BunServerWebSocket<BunWsTransportData>): void {
			const { id } = ws.data;
			clients.delete(id);
			lastSeen.delete(id);
			disconnectHandler?.(id);
		},
		pong(ws: BunServerWebSocket<BunWsTransportData>): void {
			lastSeen.set(ws.data.id, Date.now());
		},
	};

	const transport: ServerTransport = {
		async send(clientId: string, message: ServerMessage): Promise<void> {
			const ws = clients.get(clientId);
			if (!ws) {
				throw new TransportSendError(clientId, "no socket registered for client");
			}
			trySend(clientId, ws, JSON.stringify(message), maxBufferedBytes);
		},

		async broadcast(_roomId: string, message: ServerMessage, exclude?: string): Promise<void> {
			const data = JSON.stringify(message);
			// Fan-out, not per-client delivery accounting: one dead socket must
			// not abort the rest, so failures are logged rather than thrown.
			for (const [id, ws] of clients) {
				if (id === exclude) continue;
				try {
					trySend(id, ws, data, maxBufferedBytes);
				} catch (err) {
					console.warn(
						"[reflectdb] bun-ws broadcast skipped a client:",
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
			for (const ws of clients.values()) ws.close();
			clients.clear();
			lastSeen.clear();
		},
	};

	return { transport, websocket };
}
