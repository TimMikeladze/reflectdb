import type {
	ClientMessage,
	ClientTransport,
	ServerMessage,
	ServerTransport,
} from "../core/types.ts";
import { TransportSendError } from "../core/types.ts";

// ── Server-side Polling Transport ───────────────────────────────────────────
// Messages are queued per-client. The HTTP layer calls handlePoll() on GET
// and handleMessage() on POST.
//
// Example HTTP integration:
//   GET  /sync/poll/:clientId   → JSON { messages: transport.handlePoll(clientId) }
//   POST /sync/send/:clientId   → transport.handleMessage(clientId, body)
//   POST /sync/connect          → transport.handleConnect(clientId)

export interface PollingServerConfig {
	/** Max queued messages per client. Older messages dropped when exceeded. Default: 1000. */
	maxQueueLen?: number;
	/** Idle timeout in ms — clients with no poll in this window are reaped. Default: 60_000. */
	idleTimeoutMs?: number;
	/** Reaper interval in ms. Default: 30_000. */
	reaperIntervalMs?: number;
	/** Max inbound JSON message bytes. Default: 1 MB. */
	maxMessageBytes?: number;
}

/** Caller validates body size against this before parsing JSON; exported for convenience. */
export function pollingBodyTooLarge(body: string, limit = 1_000_000): boolean {
	return body.length > limit;
}

export function createPollingServerTransport(
	cfg: PollingServerConfig = {},
): ServerTransport & {
	handleConnect(clientId: string): void;
	handleMessage(clientId: string, message: ClientMessage): void;
	handleDisconnect(clientId: string): void;
	handlePoll(clientId: string): ServerMessage[];
} {
	const queues = new Map<string, ServerMessage[]>();
	const lastPoll = new Map<string, number>();
	const maxQueueLen = cfg.maxQueueLen ?? 1000;
	const idleTimeoutMs = cfg.idleTimeoutMs ?? 60_000;
	const reaperIntervalMs = cfg.reaperIntervalMs ?? 30_000;
	const maxMessageBytes = cfg.maxMessageBytes ?? 1_000_000;
	let messageHandler: ((clientId: string, message: ClientMessage) => void) | null = null;
	let connectHandler: ((clientId: string, req: Request) => void) | null = null;
	let disconnectHandler: ((clientId: string) => void) | null = null;

	// Reap dead clients whose poll stopped. Without this, a backgrounded phone
	// leaves its queue growing forever until the server restarts.
	const reaper = setInterval(() => {
		const now = Date.now();
		for (const [clientId, last] of lastPoll) {
			if (now - last > idleTimeoutMs) {
				queues.delete(clientId);
				lastPoll.delete(clientId);
				disconnectHandler?.(clientId);
			}
		}
	}, reaperIntervalMs);

	// Keep the reaper from pinning the event loop alive in test/CLI contexts.
	if (typeof (reaper as unknown as { unref?: () => void }).unref === "function") {
		(reaper as unknown as { unref: () => void }).unref();
	}

	/**
	 * Append to a client's queue. Returns false when the append forced a
	 * drop-oldest eviction: the evicted message never reached the client, so
	 * `send` must report the loss rather than resolve.
	 */
	function enqueue(queue: ServerMessage[], message: ServerMessage): boolean {
		queue.push(message);
		// Drop-oldest: prefer fresh state over stale; client resumes from watermark.
		let dropped = false;
		while (queue.length > maxQueueLen) {
			queue.shift();
			dropped = true;
		}
		return !dropped;
	}

	return {
		handleConnect(clientId: string): void {
			if (!queues.has(clientId)) {
				queues.set(clientId, []);
			}
			lastPoll.set(clientId, Date.now());
			connectHandler?.(clientId, new Request("https://poll-connect"));
		},

		handleMessage(clientId: string, message: ClientMessage): void {
			lastPoll.set(clientId, Date.now());
			// Defensive size cap. HTTP POST body cap (pollingBodyTooLarge) is
			// the primary gate, but enforce here too in case caller skips it.
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
					`[reflectdb] polling: message from ${clientId} exceeds ${maxMessageBytes} bytes (${byteLen}), dropping`,
				);
				return;
			}
			messageHandler?.(clientId, message);
		},

		handleDisconnect(clientId: string): void {
			queues.delete(clientId);
			lastPoll.delete(clientId);
			disconnectHandler?.(clientId);
		},

		handlePoll(clientId: string): ServerMessage[] {
			lastPoll.set(clientId, Date.now());
			const queue = queues.get(clientId);
			if (!queue || queue.length === 0) return [];
			const messages = [...queue];
			queue.length = 0;
			return messages;
		},

		async send(clientId: string, message: ServerMessage): Promise<void> {
			const queue = queues.get(clientId);
			if (!queue) {
				throw new TransportSendError(clientId, "no queue registered for client");
			}
			if (!enqueue(queue, message)) {
				throw new TransportSendError(
					clientId,
					`polling queue overflow (max ${maxQueueLen}); oldest message dropped undelivered`,
				);
			}
		},

		async broadcast(_roomId: string, message: ServerMessage, exclude?: string): Promise<void> {
			for (const [clientId, queue] of queues) {
				if (clientId !== exclude) {
					enqueue(queue, message);
				}
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
			clearInterval(reaper);
			queues.clear();
			lastPoll.clear();
		},

		disconnect(clientId: string): void {
			queues.delete(clientId);
			lastPoll.delete(clientId);
		},
	};
}

// ── Client-side Polling Transport ───────────────────────────────────────────
// Sends messages via fetch POST, receives via periodic fetch GET.

export interface PollingClientConfig {
	/** GET endpoint that returns `{ messages: ServerMessage[] }` */
	pollUrl: string;
	/** POST endpoint for sending client messages */
	messageUrl: string;
	/** Poll interval in ms (default: 1000) */
	interval?: number;
	headers?: Record<string, string>;
}

export function createPollingClientTransport(config: PollingClientConfig): ClientTransport {
	let handler: ((message: ServerMessage) => void) | null = null;
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let intentionalClose = false;
	const abortController = new AbortController();

	async function poll(): Promise<void> {
		try {
			const response = await fetch(config.pollUrl, {
				headers: config.headers,
				signal: abortController.signal,
			});
			if (!response.ok) {
				console.warn(`[reflectdb] Poll returned ${response.status}`);
				return;
			}
			const data = (await response.json()) as { messages: ServerMessage[] };
			for (const msg of data.messages) {
				try {
					handler?.(msg);
				} catch (err) {
					console.error("[reflectdb] Polling message handler error:", err);
				}
			}
		} catch (err) {
			if (intentionalClose || (err as { name?: string }).name === "AbortError") return;
			handler?.({ type: "disconnect", reason: "poll_error" } as ServerMessage);
		}
	}

	return {
		async send(message: ClientMessage): Promise<void> {
			const res = await fetch(config.messageUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...config.headers,
				},
				body: JSON.stringify(message),
				signal: abortController.signal,
			});
			if (!res.ok) {
				throw new Error(`Polling send failed: ${res.status} ${res.statusText}`);
			}
		},

		subscribe(h: (message: ServerMessage) => void): void {
			handler = h;
			if (intervalId !== null) return; // Already polling
			poll();
			const ms = config.interval ?? 1000;
			intervalId = setInterval(poll, ms);
		},

		async close(): Promise<void> {
			intentionalClose = true;
			if (intervalId !== null) {
				clearInterval(intervalId);
				intervalId = null;
			}
			abortController.abort();
		},
	};
}
