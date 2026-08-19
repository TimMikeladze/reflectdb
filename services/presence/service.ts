/**
 * Presence service core — transport-agnostic.
 *
 * Holds no reference to Bun, WebSockets or HTTP: a connection is anything with
 * `send` and `close`, so the whole protocol is testable without opening a
 * socket. `server.ts` is the thin Bun binding over this.
 */

import { createRedisEphemeral } from "../../src/server/ephemeral/redis.ts";
import type { EphemeralAdapter } from "../../src/server/ephemeral/types.ts";
import type { RedisLike, RedisSubscriberLike } from "../../src/server/ephemeral/redis.ts";
import { createPresenceBus, type PresenceBus } from "./bus.ts";
import { createProjectRegistry, type Project, type ProjectRegistry } from "./projects.ts";
import {
	PRESENCE_PROTOCOL_VERSION,
	parseClientFrame,
	type ErrorCode,
	type PeerState,
	type ServerFrame,
} from "./protocol.ts";

/** Anything the service can write a frame to. */
export interface Connection {
	send(payload: string): void;
	close(): void;
}

interface Session {
	clientId: string;
	connection: Connection;
	project: Project | null;
	/** Project-namespaced room key, set once the client has said hello. */
	room: string | null;
	identity?: Record<string, unknown>;
	/** Channels this connection currently holds state on. */
	channels: Set<string>;
	bucket: { count: number; resetAt: number };
	/**
	 * Frames from one connection are handled one at a time. `hello` resolves an
	 * API key and acquires a connection slot before it marks the session
	 * joined — both awaits — so a client that publishes immediately after
	 * connecting would otherwise have its second frame arrive while the first
	 * is still in flight, find no project on the session, and be rejected as
	 * "first frame must be hello". The bundled client does exactly that every
	 * time it flushes its outbox after a reconnect.
	 */
	queue: Promise<unknown>;
}

export interface PresenceServiceConfig {
	client: RedisLike;
	subscriber?: RedisSubscriberLike;
	prefix?: string;
	serverId: string;
	seed?: Record<string, Partial<Project> & { projectId: string }>;
	/** Injected in tests; defaults to a Redis-backed store. */
	store?: EphemeralAdapter;
	/** Sweep interval for expired entries. 0 disables. Default 5s. */
	sweepIntervalMs?: number;
	onEvent?: (event: ServiceEvent) => void;
}

export type ServiceEvent =
	| { type: "connected"; clientId: string; projectId: string; room: string }
	| { type: "disconnected"; clientId: string; projectId: string; room: string }
	| { type: "rejected"; code: ErrorCode; reason: string }
	| { type: "published"; projectId: string; room: string; channel: string };

export interface ServiceMetrics {
	serverId: string;
	/** Connections held by this instance. */
	connections: number;
	rooms: number;
	messagesPublished: number;
	framesRejected: number;
	uptimeSeconds: number;
}

export interface PresenceService {
	start(): Promise<void>;
	/** Register a live connection. The caller owns id assignment. */
	open(clientId: string, connection: Connection): void;
	handle(clientId: string, raw: string): Promise<void>;
	close(clientId: string): Promise<void>;
	metrics(): ServiceMetrics;
	registry: ProjectRegistry;
	shutdown(): Promise<void>;
}

/** Where identity hides inside a stored payload. Never sent to a client as-is. */
const IDENTITY_FIELD = "__identity";

function frameOf(value: ServerFrame): string {
	return JSON.stringify(value);
}

export function createPresenceService(config: PresenceServiceConfig): PresenceService {
	const prefix = config.prefix ?? "presence";
	const startedAt = Date.now();

	const store: EphemeralAdapter =
		config.store ??
		createRedisEphemeral({
			client: config.client,
			prefix: `${prefix}:state`,
			// The store's own ceiling is a backstop; per-project caps are enforced
			// per room below, where the project's limit is actually known.
			maxEntries: 1_000_000,
		});

	const registry = createProjectRegistry({
		client: config.client,
		prefix,
		seed: config.seed,
	});

	const bus: PresenceBus = createPresenceBus({
		client: config.client,
		subscriber: config.subscriber,
		prefix,
		serverId: config.serverId,
	});

	const sessions = new Map<string, Session>();
	/** room → clientIds held by THIS instance. Peers elsewhere arrive via the bus. */
	const rooms = new Map<string, Set<string>>();
	let sweepTimer: ReturnType<typeof setInterval> | null = null;
	let messagesPublished = 0;
	let framesRejected = 0;

	function emit(event: ServiceEvent): void {
		config.onEvent?.(event);
	}

	function send(session: Session, frame: ServerFrame): void {
		try {
			session.connection.send(frameOf(frame));
		} catch {
			// A dead socket is discovered on close; one failed write must not
			// abort fan-out to the rest of the room.
		}
	}

	function fail(session: Session, code: ErrorCode, message: string, fatal: boolean): void {
		framesRejected++;
		emit({ type: "rejected", code, reason: message });
		send(session, { type: "error", code, message, fatal });
		if (fatal) session.connection.close();
	}

	/** Deliver to this instance's sockets in `room`, optionally skipping one. */
	function fanOutLocal(room: string, frame: ServerFrame, exclude?: string): void {
		const members = rooms.get(room);
		if (!members) return;
		for (const clientId of members) {
			if (clientId === exclude) continue;
			const session = sessions.get(clientId);
			if (session) send(session, frame);
		}
	}

	function joinRoom(room: string, clientId: string): void {
		const members = rooms.get(room) ?? new Set<string>();
		members.add(clientId);
		rooms.set(room, members);
	}

	function leaveRoom(room: string, clientId: string): void {
		const members = rooms.get(room);
		if (!members) return;
		members.delete(clientId);
		if (members.size === 0) rooms.delete(room);
	}

	/** Per-connection publish ceiling. Presence is the highest-rate frame here. */
	function allowPublish(session: Session, project: Project): boolean {
		const now = Date.now();
		if (session.bucket.resetAt <= now) {
			session.bucket = { count: 0, resetAt: now + 1000 };
		}
		if (session.bucket.count >= project.maxMessagesPerSecond) return false;
		session.bucket.count++;
		return true;
	}

	/** Handle one frame. Callers serialize these per connection. */
	async function dispatch(session: Session, raw: string): Promise<void> {
		if (!session.project || !session.room) {
			await handleHello(session, raw);
			return;
		}

		const parsed = parseClientFrame(raw);
		if (!parsed.ok) return fail(session, "bad_frame", parsed.reason, false);

		switch (parsed.frame.type) {
			case "ping":
				send(session, { type: "pong" });
				return;
			case "publish":
				await handlePublish(
					session,
					session.project,
					session.room,
					parsed.frame.channel,
					parsed.frame.data,
					parsed.frame.ttlMs,
				);
				return;
			case "clear":
				await handleClear(session, session.room, parsed.frame.channel);
				return;
			case "hello":
				// Re-joining would strand the first room's entries; the client
				// should open a second connection instead.
				fail(session, "bad_frame", "already joined a room", false);
				return;
		}
	}

	async function handleHello(session: Session, raw: string): Promise<void> {
		const parsed = parseClientFrame(raw);
		if (!parsed.ok) return fail(session, "bad_frame", parsed.reason, true);
		const frame = parsed.frame;
		if (frame.type !== "hello") {
			return fail(session, "unauthorized", "first frame must be hello", true);
		}
		if (frame.protocolVersion !== PRESENCE_PROTOCOL_VERSION) {
			return fail(
				session,
				"protocol_version",
				`server speaks protocol ${PRESENCE_PROTOCOL_VERSION}`,
				true,
			);
		}

		const project = await registry.resolve(frame.apiKey);
		if (!project) return fail(session, "unauthorized", "unknown API key", true);

		if (!(await registry.acquireConnection(project))) {
			return fail(
				session,
				"project_connection_limit",
				`project is at its ${project.maxConnections} connection limit`,
				true,
			);
		}

		session.project = project;
		session.identity = frame.identity;
		// Namespacing by project is what keeps two customers' rooms of the same
		// name from ever meeting, in the store and on the bus alike.
		session.room = `${project.projectId}:${frame.room}`;
		joinRoom(session.room, session.clientId);

		send(session, {
			type: "welcome",
			protocolVersion: PRESENCE_PROTOCOL_VERSION,
			clientId: session.clientId,
			room: frame.room,
		});

		// Snapshot before any live frame, so the client renders a full room.
		const channels = await store.getRoom(session.room);
		const peers: PeerState[] = [];
		for (const [channel, byClient] of Object.entries(channels)) {
			for (const state of Object.values(byClient)) {
				if (state.clientId === session.clientId) continue;
				// Identity is stored inside the payload because the store has no
				// field for it; split it back out so a snapshot frame and a live
				// presence frame carry exactly the same shape.
				const { [IDENTITY_FIELD]: identity, ...data } = state.data;
				peers.push({
					clientId: state.clientId,
					channel,
					data,
					identity: (identity as Record<string, unknown> | undefined) ?? undefined,
				});
			}
		}
		send(session, { type: "snapshot", peers });

		emit({
			type: "connected",
			clientId: session.clientId,
			projectId: project.projectId,
			room: session.room,
		});
	}

	async function handlePublish(
		session: Session,
		project: Project,
		room: string,
		channel: string,
		data: Record<string, unknown>,
		ttlMs: number | undefined,
	): Promise<void> {
		if (!allowPublish(session, project)) {
			return fail(session, "rate_limited", "publish rate exceeded", false);
		}

		const effectiveTtl = Math.min(ttlMs ?? project.defaultTtlMs, project.maxTtlMs);
		// Identity travels inside the stored payload so a snapshot can rebuild
		// it for a joiner — the store has no field of its own for it.
		const stored = session.identity ? { ...data, [IDENTITY_FIELD]: session.identity } : data;

		const accepted = await store.set(
			room,
			channel,
			session.clientId,
			project.projectId,
			stored,
			effectiveTtl,
		);
		if (!accepted) {
			return fail(session, "room_full", "room is at its entry limit", false);
		}

		session.channels.add(channel);
		messagesPublished++;

		const frame = {
			type: "presence" as const,
			clientId: session.clientId,
			channel,
			data,
			identity: session.identity,
		};
		fanOutLocal(room, frame, session.clientId);
		await bus.publish({ origin: config.serverId, room, frame });
		emit({ type: "published", projectId: project.projectId, room, channel });
	}

	async function handleClear(session: Session, room: string, channel: string): Promise<void> {
		await store.remove(room, channel, session.clientId);
		session.channels.delete(channel);
		const frame = { type: "leave" as const, clientId: session.clientId, channel };
		fanOutLocal(room, frame, session.clientId);
		await bus.publish({ origin: config.serverId, room, frame });
	}

	return {
		registry,

		async start(): Promise<void> {
			await registry.seed();
			await bus.subscribe((message) => {
				fanOutLocal(message.room, message.frame);
			});
			const interval = config.sweepIntervalMs ?? 5_000;
			if (interval > 0) {
				sweepTimer = setInterval(() => {
					void Promise.resolve(store.cleanupExpired()).catch((err) => {
						console.error("[presence] sweep failed:", err);
					});
				}, interval);
			}
		},

		open(clientId: string, connection: Connection): void {
			sessions.set(clientId, {
				clientId,
				connection,
				project: null,
				room: null,
				channels: new Set(),
				bucket: { count: 0, resetAt: 0 },
				queue: Promise.resolve(),
			});
		},

		async handle(clientId: string, raw: string): Promise<void> {
			const session = sessions.get(clientId);
			if (!session) return;

			// Chain rather than run concurrently: ordering is part of the
			// protocol. A `clear` must not overtake the `publish` it cancels,
			// and nothing may overtake `hello`.
			const next = session.queue.then(
				() => dispatch(session, raw),
				() => dispatch(session, raw),
			);
			session.queue = next.catch(() => undefined);
			return next;
		},

		async close(clientId: string): Promise<void> {
			const session = sessions.get(clientId);
			if (!session) return;
			sessions.delete(clientId);

			const { project, room } = session;
			if (!project || !room) return;

			leaveRoom(room, clientId);
			await store.removeClient(clientId);
			await registry.releaseConnection(project);

			// Tell peers at once. Waiting for the TTL is what leaves a ghost
			// cursor on the board after someone closes their tab.
			const frame = { type: "leave" as const, clientId };
			fanOutLocal(room, frame);
			await bus.publish({ origin: config.serverId, room, frame });

			emit({ type: "disconnected", clientId, projectId: project.projectId, room });
		},

		metrics(): ServiceMetrics {
			return {
				serverId: config.serverId,
				connections: sessions.size,
				rooms: rooms.size,
				messagesPublished,
				framesRejected,
				uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
			};
		},

		async shutdown(): Promise<void> {
			if (sweepTimer) clearInterval(sweepTimer);
			sweepTimer = null;
			bus.close();
			// Release every slot this instance held, so a rolling deploy does not
			// leave projects counted against their cap by a machine that is gone.
			for (const clientId of [...sessions.keys()]) {
				await this.close(clientId);
			}
			await store.destroy();
		},
	};
}
