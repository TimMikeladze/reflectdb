import type {
	ClientMessage,
	ClientTransport,
	ServerMessage,
	ServerTransport,
} from "../core/types.ts";
import { TransportSendError } from "../core/types.ts";

// ── Server-side SSE Transport ───────────────────────────────────────────────
// SSE is server→client only. Client→server messages arrive via HTTP POST.
// The server exposes two endpoints:
//   GET  /sync/events/:clientId  → SSE stream
//   POST /sync/messages/:clientId → client messages

export interface SseServerConfig {
	/** Max replay buffer size per client. Default: 256. */
	replayBufferSize?: number;
	/**
	 * Defensive cap on inbound message JSON byte length. The HTTP POST handler
	 * should size-gate the request body before parsing, but this catches a
	 * caller that forgets — preferable to silently accepting unbounded JSON.
	 * Default: 1 MB.
	 */
	maxMessageBytes?: number;
}

export function createSseServerTransport(
	cfg: SseServerConfig = {},
): ServerTransport & {
	handleSubscribe(
		clientId: string,
		controller: ReadableStreamDefaultController,
		lastEventId?: string,
	): void;
	handleMessage(clientId: string, message: ClientMessage): void;
	handleDisconnect(clientId: string): void;
	createEventStream(clientId: string, lastEventId?: string): ReadableStream;
} {
	const controllers = new Map<string, ReadableStreamDefaultController>();
	const buffers = new Map<
		string,
		Array<{ id: number; encoded: Uint8Array; delivered: boolean }>
	>();
	const counters = new Map<string, number>();
	const replayBufferSize = cfg.replayBufferSize ?? 256;
	const maxMessageBytes = cfg.maxMessageBytes ?? 1_000_000;
	let messageHandler: ((clientId: string, message: ClientMessage) => void) | null = null;
	let connectHandler: ((clientId: string, req: Request) => void) | null = null;
	let disconnectHandler: ((clientId: string) => void) | null = null;

	const encoder = new TextEncoder();

	function encode(id: number, message: ServerMessage): Uint8Array {
		const data = JSON.stringify(message);
		return encoder.encode(`id: ${id}\ndata: ${data}\n\n`);
	}

	/**
	 * Append to the replay buffer, evicting oldest past the cap. Returns true if
	 * an entry that was never streamed to a live controller got evicted — that
	 * frame is now unrecoverable and the caller must surface the loss.
	 */
	function buffer(
		clientId: string,
		id: number,
		encoded: Uint8Array,
		delivered: boolean,
	): boolean {
		let buf = buffers.get(clientId);
		if (!buf) {
			buf = [];
			buffers.set(clientId, buf);
		}
		buf.push({ id, encoded, delivered });
		let lostUndelivered = false;
		while (buf.length > replayBufferSize) {
			const dropped = buf.shift();
			if (dropped && !dropped.delivered) lostUndelivered = true;
		}
		return lostUndelivered;
	}

	function nextId(clientId: string): number {
		const id = (counters.get(clientId) ?? 0) + 1;
		counters.set(clientId, id);
		return id;
	}

	return {
		handleSubscribe(
			clientId: string,
			controller: ReadableStreamDefaultController,
			lastEventId?: string,
		): void {
			controllers.set(clientId, controller);
			// Replay anything sent after lastEventId so reconnect doesn't drop messages.
			if (lastEventId) {
				const lastId = Number(lastEventId);
				const buf = buffers.get(clientId);
				if (buf && Number.isFinite(lastId)) {
					for (const entry of buf) {
						if (entry.id > lastId) {
							controller.enqueue(entry.encoded);
							entry.delivered = true;
						}
					}
				}
			}
			connectHandler?.(clientId, new Request("https://sse-connect"));
		},

		handleMessage(clientId: string, message: ClientMessage): void {
			// Defensive size cap: HTTP POST handler should body-gate too, but
			// without this a caller that forgets can swamp the server.
			let byteLen: number;
			try {
				const stringified = JSON.stringify(message);
				byteLen =
					typeof Buffer !== "undefined"
						? Buffer.byteLength(stringified, "utf8")
						: new Blob([stringified]).size;
			} catch {
				byteLen = 0;
			}
			if (byteLen > maxMessageBytes) {
				console.warn(
					`[reflectdb] SSE: message from ${clientId} exceeds ${maxMessageBytes} bytes (${byteLen}), dropping`,
				);
				return;
			}
			messageHandler?.(clientId, message);
		},

		handleDisconnect(clientId: string): void {
			controllers.delete(clientId);
			// Keep buffer + counter — client may reconnect with Last-Event-ID.
			disconnectHandler?.(clientId);
		},

		createEventStream(clientId: string, lastEventId?: string): ReadableStream {
			return new ReadableStream({
				start: (controller) => {
					this.handleSubscribe(clientId, controller, lastEventId);
				},
				cancel: () => {
					this.handleDisconnect(clientId);
				},
			});
		},

		async send(clientId: string, message: ServerMessage): Promise<void> {
			const id = nextId(clientId);
			const encoded = encode(id, message);
			const controller = controllers.get(clientId);

			let sendError: unknown;
			let delivered = false;
			if (controller) {
				try {
					controller.enqueue(encoded);
					delivered = true;
				} catch (err) {
					sendError = err;
				}
			}

			// Buffer regardless: a frame that couldn't stream now may still reach
			// the client via Last-Event-ID replay after reconnect.
			const lostUndelivered = buffer(clientId, id, encoded, delivered);

			if (sendError) {
				throw new TransportSendError(
					clientId,
					`sse enqueue failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
					sendError,
				);
			}
			// A never-streamed frame aging out of the replay buffer is genuinely
			// lost — report it so the broadcast engine doesn't commit the client's
			// result cache as if the delta had landed.
			if (lostUndelivered) {
				throw new TransportSendError(
					clientId,
					`sse replay buffer overflow (size ${replayBufferSize}); undelivered frames dropped`,
				);
			}
		},

		async broadcast(_roomId: string, message: ServerMessage, exclude?: string): Promise<void> {
			for (const [clientId, controller] of controllers) {
				if (clientId === exclude) continue;
				const id = nextId(clientId);
				const encoded = encode(id, message);
				let delivered = false;
				try {
					controller.enqueue(encoded);
					delivered = true;
				} catch (err) {
					console.warn(
						"[reflectdb] sse broadcast skipped a client:",
						err instanceof Error ? err.message : err,
					);
				}
				buffer(clientId, id, encoded, delivered);
			}
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
			for (const controller of controllers.values()) {
				try {
					controller.close();
				} catch {
					// Already closed
				}
			}
			controllers.clear();
			buffers.clear();
			counters.clear();
		},

		disconnect(clientId: string): void {
			const controller = controllers.get(clientId);
			if (controller) {
				try {
					controller.close();
				} catch {
					// already closed
				}
			}
			controllers.delete(clientId);
			buffers.delete(clientId);
			counters.delete(clientId);
		},
	};
}

// ── Client-side SSE Transport ───────────────────────────────────────────────
// Uses EventSource for receiving and fetch POST for sending.

export interface SseClientConfig {
	eventUrl: string;
	messageUrl: string;
	headers?: Record<string, string>;
}

export function createSseClientTransport(config: SseClientConfig): ClientTransport {
	let eventSource: EventSource | null = null;
	let handler: ((message: ServerMessage) => void) | null = null;

	let intentionalClose = false;

	return {
		async send(message: ClientMessage): Promise<void> {
			const res = await fetch(config.messageUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...config.headers,
				},
				body: JSON.stringify(message),
			});
			// Surface server-side rejections (auth fail, 5xx, etc.) so caller
			// can react instead of treating "fetch resolved" as "delivered".
			if (!res.ok) {
				throw new Error(`SSE send failed: ${res.status} ${res.statusText}`);
			}
		},

		subscribe(h: (message: ServerMessage) => void): void {
			handler = h;
			if (eventSource) return; // Already subscribed
			eventSource = new EventSource(config.eventUrl);
			eventSource.onmessage = (event) => {
				try {
					const message = JSON.parse(event.data) as ServerMessage;
					handler?.(message);
				} catch (err) {
					console.warn(
						"[reflectdb] SSE: malformed message ignored:",
						err instanceof Error ? err.message : String(err),
					);
				}
			};
			eventSource.onerror = () => {
				if (!intentionalClose) {
					handler?.({ type: "disconnect", reason: "sse_error" });
				}
			};
		},

		async close(): Promise<void> {
			intentionalClose = true;
			if (eventSource) {
				eventSource.close();
				eventSource = null;
			}
		},
	};
}
