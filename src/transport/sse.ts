import type {
	ClientMessage,
	ClientTransport,
	ServerMessage,
	ServerTransport,
} from "../core/types.ts";
import { TransportSendError } from "../core/types.ts";

/**
 * Bounds on how long `collectReplies` waits for a message's replies to stop
 * arriving. Consecutive quiet ticks mean the pipeline has finished producing;
 * the ceiling stops a wedged handler from holding an HTTP request open.
 */
const COLLECT_STABLE_TICKS = 3;
const MAX_COLLECT_TICKS = 60;

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
	/**
	 * Return replies from the POST that produced them instead of assuming they
	 * can be streamed.
	 *
	 * Normally SSE is server→client only: a client POSTs a message and every
	 * reply — `hello_ack`, snapshots, op acks — comes back down the held stream.
	 * That works only while the POST and the stream are handled by the SAME
	 * process. On a serverless platform (Vercel, Lambda, Workers) they are two
	 * separate invocations, so those replies would be enqueued onto a stream the
	 * POST's process does not have, and the client would hang at the handshake.
	 *
	 * With this set, `collectReplies` runs a message and hands back what it
	 * produced so the HTTP handler can put it in the POST response body. The
	 * stream is then only used for what it is actually good at: pushing OTHER
	 * clients' changes. Pair it with `serverless: true` on the client transport.
	 *
	 * Off by default — a single-process server should keep streaming everything,
	 * and turning this on there would deliver each reply twice.
	 */
	serverless?: boolean;
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
	collectReplies(
		clientId: string,
		message: ClientMessage,
		settle?: () => Promise<void>,
	): Promise<ServerMessage[]>;
} {
	const controllers = new Map<string, ReadableStreamDefaultController>();
	const buffers = new Map<
		string,
		Array<{ id: number; encoded: Uint8Array; delivered: boolean }>
	>();
	const counters = new Map<string, number>();
	const replayBufferSize = cfg.replayBufferSize ?? 256;
	const serverless = cfg.serverless ?? false;
	/**
	 * Per-client sink active only for the duration of a `collectReplies` call.
	 * Its presence is what diverts `send` away from the (absent) stream.
	 */
	const collecting = new Map<string, ServerMessage[]>();
	/**
	 * Clients this process has already announced to the server via
	 * `connectHandler`. A session is created by that callback, so without it
	 * every message after `hello` fails the authentication gate.
	 */
	const connected = new Set<string>();
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
			if (!connected.has(clientId)) {
				connected.add(clientId);
				connectHandler?.(clientId, new Request("https://sse-connect"));
			}
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
			connected.delete(clientId);
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
			// A reply produced while handling a POST goes back in that POST's
			// response, not onto a stream this process does not own.
			const sink = collecting.get(clientId);
			if (sink) {
				sink.push(message);
				return;
			}
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

		/**
		 * Runs one client message and returns everything the server produced for
		 * that client, for the HTTP handler to return as the POST response body.
		 *
		 * Only meaningful with `serverless: true`; otherwise it runs the message
		 * and returns nothing, because the replies were streamed as usual.
		 *
		 * Replies are collected rather than streamed for exactly the duration of
		 * the call. Anything the server produces for OTHER clients still takes the
		 * normal path, so a broadcast triggered by this message is unaffected.
		 */
		async collectReplies(
			clientId: string,
			message: ClientMessage,
			settle?: () => Promise<void>,
		): Promise<ServerMessage[]> {
			if (!serverless) {
				this.handleMessage(clientId, message);
				return [];
			}
			// Announce the client before its first message. On a long-lived server
			// the stream's `handleSubscribe` does this, but a serverless POST has no
			// stream in its process — so without it `hello` would authenticate a
			// session that does not exist, and every later message would come back
			// "Not authenticated".
			if (!connected.has(clientId)) {
				connected.add(clientId);
				connectHandler?.(clientId, new Request("https://sse-connect"));
			}

			const sink: ServerMessage[] = [];
			collecting.set(clientId, sink);
			try {
				this.handleMessage(clientId, message);
				// The handler pipeline is async (auth, storage, query execution) and
				// `handleMessage` returns before it settles, so the POST would
				// otherwise reply with an empty body and the client would hang.
				//
				// `settle` waits on the real per-client work queue — pass
				// `() => handler.whenIdle(clientId)`. That is necessary but not
				// sufficient: applying an op continues onto chained promises (durable
				// flush, broadcast) that resolve AFTER the queue entry does, and the
				// ack is produced there. So the queue is drained first, then replies
				// are allowed to stop arriving on their own. Without the second half
				// an `ops` POST intermittently returns `[]` and the client waits for
				// an ack that already happened.
				await (settle?.() ?? Promise.resolve());
				let stable = 0;
				for (let i = 0; i < MAX_COLLECT_TICKS && stable < COLLECT_STABLE_TICKS; i++) {
					const before = sink.length;
					await new Promise((resolve) => setTimeout(resolve, 0));
					stable = sink.length === before ? stable + 1 : 0;
				}
			} finally {
				collecting.delete(clientId);
			}
			return sink;
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
	/**
	 * Read replies out of the POST response instead of waiting for them on the
	 * stream. Must match `serverless: true` on the server transport.
	 *
	 * Needed wherever the POST and the event stream are handled by different
	 * processes — Vercel, Lambda, Workers. There, replies to a POST are produced
	 * by a process that does not own this client's stream, so they can never be
	 * streamed and the handshake never completes.
	 *
	 * Leave it off for a single-process server: replies stream normally there,
	 * and turning it on would deliver every one of them twice.
	 */
	serverless?: boolean;
}

export function createSseClientTransport(config: SseClientConfig): ClientTransport {
	// `handler` is assigned by `subscribe`, which SyncClient calls before its
	// first `send`, so inline replies always have somewhere to go.
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
			if (!config.serverless) return;

			// In serverless mode the POST carries its own replies: the process that
			// handled it does not own this client's stream, so `hello_ack`, the
			// bootstrap snapshots and op acks all come back here. Without this the
			// client would sit at the handshake forever.
			let replies: ServerMessage[];
			try {
				const body = (await res.json()) as { messages?: ServerMessage[] } | ServerMessage[];
				replies = Array.isArray(body) ? body : (body.messages ?? []);
			} catch {
				// A 200 with no JSON body is a server that is not in serverless mode.
				// Nothing to dispatch, and the stream may yet deliver — so this is
				// not fatal, but it is worth saying out loud, because the symptom
				// (a client stuck connecting) points nowhere near the cause.
				console.warn(
					"[reflectdb] SSE: serverless mode is on but the POST returned no JSON replies. " +
						"Set `serverless: true` on createSseServerTransport and return " +
						"`collectReplies(...)` from the message endpoint.",
				);
				return;
			}
			for (const reply of replies) handler?.(reply);
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
