/**
 * Presence service core — transport-agnostic.
 *
 * Holds no reference to Vercel, Node's `http`, or Bun: a stream is anything
 * with `write` and `close`, so the whole protocol is testable without opening
 * a connection. The handlers under `api/` are thin bindings over this.
 *
 * The shape here follows from where it runs. On a platform with no sockets,
 * the request that reads a room and the request that writes it are different
 * requests on different machines, so:
 *
 *   - **Publishing is stateless.** A `publish` needs no prior stream and no
 *     session: it authenticates, clamps, and writes. Nothing about it depends
 *     on which instance the client's stream happens to be on.
 *   - **Reading is a poll.** With no bus to subscribe to, an open stream reads
 *     its room on a timer and sends the difference. One `RoomWatcher` per room
 *     per instance does that reading, so ten visitors on one instance cost one
 *     query per tick rather than ten.
 */

import {
	PRESENCE_PROTOCOL_VERSION,
	encodeFrame,
	payloadTooLarge,
	type ErrorCode,
	type LeaveRequest,
	type PeerState,
	type PublishRequest,
	type ServerFrame,
	type StreamRequest,
} from "./protocol.js";
import {
	createProjectRegistry,
	type Project,
	type ProjectRegistry,
	type SeedDefinition,
} from "./projects.js";
import type { PresenceStore, SqlClient, StoredEntry } from "./store.js";

/** Anything the service can write stream bytes to. */
export interface StreamSink {
	write(chunk: string): void;
	close(): void;
}

/** A refused command, ready to become an HTTP status. */
export interface CommandFailure {
	ok: false;
	status: number;
	code: ErrorCode;
	message: string;
}

/** Result of a `publish` or `leave`. */
export type CommandResult = { ok: true } | CommandFailure;

export interface PresenceServiceConfig {
	store: PresenceStore;
	/** Resolves API keys. Defaults to the Postgres-backed one, which needs `sql`. */
	registry?: ProjectRegistry;
	sql?: SqlClient;
	seed?: Record<string, SeedDefinition>;
	/**
	 * How long one stream stays open before it closes itself.
	 *
	 * Serverless functions have a wall-clock ceiling, so the choice is between
	 * ending the stream deliberately and being cut off mid-frame. Default 55s,
	 * comfortably under every plan's limit.
	 */
	streamMs?: number;
	/** Poll interval while other people are in the room. Default 200ms. */
	fastPollMs?: number;
	/** Poll interval while a client is alone. Default 1000ms. */
	idlePollMs?: number;
	/** SSE comment interval, to hold the connection open through proxies. */
	keepaliveMs?: number;
	/** Expired rows are swept every N polls of an active room. Default 60. */
	sweepEveryPolls?: number;
	onEvent?: (event: ServiceEvent) => void;
	/** Injected in tests. */
	now?: () => number;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
}

export type ServiceEvent =
	| { type: "stream_opened"; clientId: string; projectId: string; room: string }
	| { type: "stream_closed"; clientId: string; projectId: string; room: string }
	| { type: "published"; projectId: string; room: string; channel: string }
	| { type: "rejected"; code: ErrorCode; reason: string };

export interface ServiceMetrics {
	/** Streams this instance is holding open. */
	streams: number;
	/** Rooms this instance is polling. */
	rooms: number;
	messagesPublished: number;
	requestsRejected: number;
	uptimeSeconds: number;
}

export interface PresenceService {
	publish(request: PublishRequest): Promise<CommandResult>;
	leave(request: LeaveRequest): Promise<CommandResult>;
	/**
	 * Attach a sink to a room. Resolves once the stream has been accepted and
	 * the opening frames written, or rejected and closed.
	 */
	openStream(request: StreamRequest, sink: StreamSink): Promise<CommandResult>;
	metrics(): ServiceMetrics;
	registry: ProjectRegistry;
	shutdown(): Promise<void>;
}

const DEFAULTS = {
	streamMs: 55_000,
	fastPollMs: 200,
	idlePollMs: 1_000,
	keepaliveMs: 15_000,
	sweepEveryPolls: 60,
};

/** Consecutive failed polls before a room gives up and closes its streams. */
const MAX_POLL_FAILURES = 5;

function missingSql(): never {
	throw new Error("createPresenceService needs either `sql` or a `registry`");
}

function entryKey(channel: string, clientId: string): string {
	return `${channel}\u0000${clientId}`;
}

function peerOf(entry: StoredEntry): PeerState {
	return {
		clientId: entry.clientId,
		channel: entry.channel,
		data: entry.data,
		identity: entry.identity,
	};
}

interface Subscriber {
	clientId: string;
	sink: StreamSink;
}

interface RoomWatcher {
	subscribers: Set<Subscriber>;
	/** Last room view this watcher read, keyed by channel and client. */
	entries: Map<string, StoredEntry>;
	timer: unknown;
	intervalMs: number;
	polls: number;
	failures: number;
	stopped: boolean;
}

export function createPresenceService(config: PresenceServiceConfig): PresenceService {
	const store = config.store;
	const streamMs = config.streamMs ?? DEFAULTS.streamMs;
	const fastPollMs = config.fastPollMs ?? DEFAULTS.fastPollMs;
	const idlePollMs = config.idlePollMs ?? DEFAULTS.idlePollMs;
	const keepaliveMs = config.keepaliveMs ?? DEFAULTS.keepaliveMs;
	const sweepEveryPolls = config.sweepEveryPolls ?? DEFAULTS.sweepEveryPolls;
	const now = config.now ?? Date.now;
	const setTimer = config.setInterval ?? ((fn, ms) => setInterval(fn, ms));
	const clearTimer =
		config.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
	const setOnce = config.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const clearOnce =
		config.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

	const startedAt = now();
	let messagesPublished = 0;
	let requestsRejected = 0;

	const registry =
		config.registry ??
		createProjectRegistry({
			sql: config.sql ?? missingSql(),
			store,
			seed: config.seed,
		});

	/** `projectId:room` → watcher. Only ever holds this instance's streams. */
	const watchers = new Map<string, RoomWatcher>();

	function emit(event: ServiceEvent): void {
		config.onEvent?.(event);
	}

	function reject(status: number, code: ErrorCode, message: string): CommandFailure {
		requestsRejected++;
		emit({ type: "rejected", code, reason: message });
		return { ok: false, status, code, message };
	}

	function writeTo(sink: StreamSink, frame: ServerFrame): void {
		try {
			sink.write(encodeFrame(frame));
		} catch {
			// A dead stream is discovered when its request ends; one failed
			// write must not abort fan-out to the rest of the room.
		}
	}

	/**
	 * Rooms are namespaced by project everywhere they are keyed — in the store,
	 * and in this instance's watcher map. It is what keeps two customers with a
	 * room called `board-1` from ever meeting.
	 */
	function watcherKey(projectId: string, room: string): string {
		return `${projectId}\u0000${room}`;
	}

	// ── Room polling ──────────────────────────────────────────────────────

	function broadcast(watcher: RoomWatcher, frame: ServerFrame, exclude?: string): void {
		for (const subscriber of watcher.subscribers) {
			if (subscriber.clientId === exclude) continue;
			writeTo(subscriber.sink, frame);
		}
	}

	/**
	 * Read the room and send what changed.
	 *
	 * The baseline is the watcher's, not each subscriber's: a stream that
	 * joined mid-tick was handed a fresh snapshot of its own, so the worst this
	 * can do is re-send a peer state it already has, which is idempotent. The
	 * alternative — a baseline per subscriber — costs a map per viewer to avoid
	 * a duplicate frame nobody can observe.
	 */
	async function poll(key: string, projectId: string, room: string): Promise<void> {
		const watcher = watchers.get(key);
		if (!watcher || watcher.stopped) return;

		let entries: StoredEntry[];
		try {
			entries = await store.room(projectId, room);
			watcher.failures = 0;
		} catch (err) {
			watcher.failures++;
			console.error(`[presence] poll failed for ${room}:`, err);
			if (watcher.failures >= MAX_POLL_FAILURES) {
				// Streams that cannot be fed are worse than closed ones: the
				// client sits on a live connection watching a frozen room.
				broadcast(watcher, {
					type: "error",
					code: "internal",
					message: "presence store is unreachable",
					fatal: true,
				});
				// Copied, not iterated live: `detach` removes from this set and
				// deletes the watcher entirely once it empties.
				for (const subscriber of [...watcher.subscribers]) detach(key, subscriber);
			}
			return;
		}

		const next = new Map<string, StoredEntry>();
		for (const entry of entries) next.set(entryKey(entry.channel, entry.clientId), entry);

		for (const [id, entry] of next) {
			const previous = watcher.entries.get(id);
			if (previous && previous.updatedAt === entry.updatedAt) continue;
			broadcast(watcher, { type: "presence", ...peerOf(entry) }, entry.clientId);
		}
		for (const [id, entry] of watcher.entries) {
			if (next.has(id)) continue;
			// Gone means cleared, left, or expired. The client treats all three
			// the same way — drop the peer — so the stream does not distinguish.
			broadcast(watcher, { type: "leave", clientId: entry.clientId, channel: entry.channel });
		}
		watcher.entries = next;

		// A client alone in a room has nobody to see move. Polling it five
		// times a second buys nothing and is most of the load a quiet page
		// would otherwise generate.
		const occupants = new Set(entries.map((entry) => entry.clientId));
		const wanted = occupants.size > 1 ? fastPollMs : idlePollMs;
		if (wanted !== watcher.intervalMs) {
			clearTimer(watcher.timer);
			watcher.intervalMs = wanted;
			watcher.timer = setTimer(() => void poll(key, projectId, room), wanted);
		}

		// No daemon runs on a serverless platform, so expiry is swept by
		// whoever happens to be watching. A room nobody watches accumulates
		// nothing that a read does not already filter out.
		watcher.polls++;
		if (watcher.polls % sweepEveryPolls === 0) {
			void Promise.resolve(store.sweep()).catch((err) => {
				console.error("[presence] sweep failed:", err);
			});
		}
	}

	function watcherFor(projectId: string, room: string): RoomWatcher {
		const key = watcherKey(projectId, room);
		const existing = watchers.get(key);
		if (existing) return existing;

		const watcher: RoomWatcher = {
			subscribers: new Set(),
			entries: new Map(),
			timer: null,
			intervalMs: fastPollMs,
			polls: 0,
			failures: 0,
			stopped: false,
		};
		watcher.timer = setTimer(() => void poll(key, projectId, room), fastPollMs);
		watchers.set(key, watcher);
		return watcher;
	}

	function detach(key: string, subscriber: Subscriber): void {
		const watcher = watchers.get(key);
		if (!watcher) return;
		watcher.subscribers.delete(subscriber);
		try {
			subscriber.sink.close();
		} catch {
			// Already ended by the platform.
		}
		if (watcher.subscribers.size > 0) return;
		watcher.stopped = true;
		clearTimer(watcher.timer);
		watchers.delete(key);
	}

	// ── Commands ──────────────────────────────────────────────────────────

	type Authorized =
		| { project: Project; error?: undefined }
		| { project?: undefined; error: CommandFailure };

	async function authorize(apiKey: string): Promise<Authorized> {
		let project: Project | null;
		try {
			project = await registry.resolve(apiKey);
		} catch (err) {
			console.error("[presence] key lookup failed:", err);
			return { error: reject(503, "internal", "presence store is unreachable") };
		}
		if (!project) return { error: reject(401, "unauthorized", "unknown API key") };
		return { project };
	}

	return {
		registry,

		async publish(request: PublishRequest): Promise<CommandResult> {
			const { project, error } = await authorize(request.apiKey);
			if (error) return error;

			if (payloadTooLarge(request.data)) {
				return reject(413, "bad_request", "data exceeds the payload limit");
			}

			const ttlMs = Math.min(request.ttlMs ?? project.defaultTtlMs, project.maxTtlMs);
			// The rate limit is expressed as a minimum gap rather than a bucket
			// because that is what the store can enforce inside the same write
			// — see `store.ts`. A bucket would need a counter every instance
			// agreed on, which is a second round trip per cursor move.
			const minIntervalMs = Math.floor(1000 / project.maxMessagesPerSecond);

			let outcome: Awaited<ReturnType<PresenceStore["write"]>>;
			try {
				outcome = await store.write({
					projectId: project.projectId,
					room: request.room,
					channel: request.channel,
					clientId: request.clientId,
					data: request.data,
					identity: request.identity,
					ttlMs,
					maxEntriesPerRoom: project.maxEntriesPerRoom,
					minIntervalMs,
				});
			} catch (err) {
				console.error("[presence] publish failed:", err);
				return reject(503, "internal", "presence store is unreachable");
			}

			if (outcome === "rate_limited") {
				return reject(429, "rate_limited", "publish rate exceeded");
			}
			if (outcome === "room_full") {
				return reject(409, "room_full", "room is at its entry limit");
			}

			messagesPublished++;
			emit({
				type: "published",
				projectId: project.projectId,
				room: request.room,
				channel: request.channel,
			});
			return { ok: true };
		},

		async leave(request: LeaveRequest): Promise<CommandResult> {
			const { project, error } = await authorize(request.apiKey);
			if (error) return error;
			try {
				await store.remove(project.projectId, request.room, request.clientId, request.channel);
			} catch (err) {
				console.error("[presence] leave failed:", err);
				return reject(503, "internal", "presence store is unreachable");
			}
			return { ok: true };
		},

		async openStream(request: StreamRequest, sink: StreamSink): Promise<CommandResult> {
			/** Send a refusal down the stream and end it. */
			const deny = (failure: CommandFailure): CommandFailure => {
				writeTo(sink, {
					type: "error",
					code: failure.code,
					message: failure.message,
					fatal: true,
				});
				try {
					sink.close();
				} catch {
					// Already ended.
				}
				return failure;
			};
			const refuse = (status: number, code: ErrorCode, message: string): CommandFailure =>
				deny(reject(status, code, message));

			const { project, error } = await authorize(request.apiKey);
			// The stream already returned 200 with its SSE headers by the time
			// a key can be checked, so a refusal has to travel as a frame. An
			// `EventSource` cannot read a status code either way — it sees only
			// "the connection failed" and retries forever unless it is told.
			// `reject` already counted this one; denying it must not count it again.
			if (error) return deny(error);

			let hasCapacity: boolean;
			try {
				hasCapacity = await registry.hasCapacity(project, request.clientId);
			} catch (err) {
				console.error("[presence] capacity check failed:", err);
				return refuse(503, "internal", "presence store is unreachable");
			}
			if (!hasCapacity) {
				return refuse(
					429,
					"project_connection_limit",
					`project is at its ${project.maxConnections} client limit`,
				);
			}

			// Tell the browser how long to wait before reopening. EventSource
			// defaults to 3s, which would make every scheduled recycle look
			// like a three-second outage.
			sink.write(`retry: 500\n\n`);
			writeTo(sink, {
				type: "welcome",
				protocolVersion: PRESENCE_PROTOCOL_VERSION,
				clientId: request.clientId,
				room: request.room,
				streamMs,
			});

			// Read fresh rather than reuse the watcher's view: a joiner that is
			// handed a tick-old room is exactly the "empty room until someone
			// moves" failure the snapshot exists to prevent.
			let entries: StoredEntry[];
			try {
				entries = await store.room(project.projectId, request.room);
			} catch (err) {
				console.error("[presence] snapshot failed:", err);
				return refuse(503, "internal", "presence store is unreachable");
			}
			writeTo(sink, {
				type: "snapshot",
				peers: entries.filter((e) => e.clientId !== request.clientId).map(peerOf),
			});

			const { projectId } = project;
			const key = watcherKey(projectId, request.room);
			const watcher = watcherFor(projectId, request.room);
			const subscriber: Subscriber = { clientId: request.clientId, sink };
			watcher.subscribers.add(subscriber);

			emit({ type: "stream_opened", clientId: request.clientId, projectId, room: request.room });

			const keepalive = setTimer(() => {
				// An SSE comment. Proxies and load balancers close a connection
				// that has sent nothing for long enough, and a quiet room sends
				// nothing by definition.
				try {
					sink.write(":\n\n");
				} catch {
					// The request ended; the recycle timer will clean up.
				}
			}, keepaliveMs);

			const recycle = setOnce(() => {
				writeTo(sink, { type: "bye", reason: "recycle" });
				finish();
			}, streamMs);

			let finished = false;
			function finish(): void {
				if (finished) return;
				finished = true;
				clearTimer(keepalive);
				clearOnce(recycle);
				detach(key, subscriber);
				emit({ type: "stream_closed", clientId: request.clientId, projectId, room: request.room });
			}

			// The binding calls this when the client goes away mid-stream.
			streamFinishers.set(sink, finish);
			return { ok: true };
		},

		metrics(): ServiceMetrics {
			let streams = 0;
			for (const watcher of watchers.values()) streams += watcher.subscribers.size;
			return {
				streams,
				rooms: watchers.size,
				messagesPublished,
				requestsRejected,
				uptimeSeconds: Math.floor((now() - startedAt) / 1000),
			};
		},

		async shutdown(): Promise<void> {
			// Both copied for the same reason: `detach` mutates `watchers` and
			// the subscriber set as it goes.
			for (const [key, watcher] of [...watchers]) {
				for (const subscriber of [...watcher.subscribers]) detach(key, subscriber);
			}
			watchers.clear();
			await store.close();
		},
	};
}

/**
 * Sink → its teardown, so a binding can end a stream it did not open.
 *
 * A `WeakMap` rather than a field on the sink: the sink is the platform's
 * object (a Node `ServerResponse`, a `ReadableStream` controller), and
 * decorating somebody else's object with service state invites a collision.
 */
const streamFinishers = new WeakMap<StreamSink, () => void>();

/** End a stream the client abandoned. Safe to call more than once. */
export function closeStream(sink: StreamSink): void {
	streamFinishers.get(sink)?.();
}
