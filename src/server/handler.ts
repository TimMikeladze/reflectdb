import type {
	AuthContext,
	ClientMessage,
	ErrorReason,
	OpType,
	ServerTransport,
	EphemeralMessage,
	LoadMoreMessage,
} from "../core/types.ts";
// OpType re-export to keep handler types aligned with SyncServer.applyServerOp signature.
import {
	PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	MAX_BATCH_SIZE,
	reasonFromError,
} from "../core/types.ts";
import { ServerClock } from "./server-clock.ts";
import type { ExistingRow } from "./conflict.ts";
import type { RateLimiter } from "./enforcement.ts";
import { SessionManager } from "./session.ts";
import type { ClientSession } from "./session.ts";
import type {
	AuthCallback,
	AuthorizeAction,
	MutationContext,
	QueryCallback,
	QueryOptions,
	RoomCallback,
	SyncEvent,
} from "./types.ts";

import { ResultCache } from "./result-cache.ts";
import { BroadcastEngine } from "./broadcast-engine.ts";
import { OpProcessor } from "./op-processor.ts";
import { EphemeralManager } from "./ephemeral-manager.ts";
import { EagerBuffer } from "./eager-buffer.ts";
import { validateClientMessage } from "./message-validator.ts";
import { CompactionManager } from "./compaction-manager.ts";
import { ReplayDetector } from "./replay-detector.ts";
import { resolveRoomKey } from "./rooms.ts";

/**
 * Default ceiling on ephemeral (presence/cursor) messages per client per
 * second. Generous enough for a 100ms cursor stream with headroom, low enough
 * that one client can't turn the fanout into an amplification channel.
 * Override with `rateLimit({ ephemeralPerSecond })`.
 */
export const DEFAULT_EPHEMERAL_PER_SECOND = 60;

export interface HandlerConfig {
	transport: ServerTransport;
	serverId: string;
	db?: unknown;
	onEvent?: (event: SyncEvent) => void;
	/**
	 * Max concurrent sessions for a single userId. Beyond the cap the
	 * oldest session is evicted so a misbehaving client can't exhaust
	 * server memory by opening unbounded connections.
	 */
	maxConnectionsPerUser?: number;
	/**
	 * Accept connections when no `auth()` callback is registered, assigning each
	 * session a synthetic `anon:<clientId>` identity. Without this opt-in, a
	 * server with no auth callback rejects the handshake instead of acking
	 * `hello` and then failing every later message as unauthenticated.
	 */
	allowAnonymous?: boolean;
	/**
	 * Abort a query execution that exceeds this many ms during broadcast. One
	 * slow query would otherwise stall fanout to every subscriber. 0 disables.
	 * Default: 0 (disabled).
	 */
	queryTimeoutMs?: number;
	/** Max subscriber groups whose queries run concurrently per broadcast. Default: 8. */
	maxBroadcastConcurrency?: number;
}

export interface QueryRegistration {
	name: string;
	callback: QueryCallback;
	tableDependencies: Set<string>;
	options: QueryOptions;
}

export interface RoomRegistration {
	pattern: string;
	regex: RegExp;
	paramNames: string[];
	callback: RoomCallback;
}

export interface OpLogEntry {
	table: string;
	op: string;
	rowId: string;
	payload: Record<string, unknown> | null;
	hlc: string;
	colClocks: Record<string, string>;
}

export interface StorageAdapter {
	getRow(table: string, rowId: string): Promise<ExistingRow>;
	/**
	 * Read many rows of one table in a single round trip, keyed by rowId.
	 * Missing rows are simply absent from the result.
	 *
	 * A 100-op batch otherwise issues 100 sequential `getRow` calls before it
	 * can even start writing. Optional — the handler falls back to `getRow`.
	 */
	getRowsByIds?(table: string, rowIds: string[]): Promise<Record<string, ExistingRow>>;
	putRow(
		table: string,
		rowId: string,
		row: Record<string, unknown> | null,
		colClocks: Record<string, string>,
		hlc: string,
	): Promise<void>;
	getRows(
		table: string,
		filter?: Record<string, unknown>,
	): Promise<{
		rows: Record<string, unknown>[];
		colClocks: Record<string, Record<string, string>>;
	}>;
	appendOp(entry: OpLogEntry): Promise<void>;
	/**
	 * Atomic write: putRow + appendOp in a single transaction.
	 * Prevents divergence between the row store and op log on crash.
	 * Optional — handler falls back to sequential putRow+appendOp if absent.
	 */
	applyOp?(
		table: string,
		rowId: string,
		row: Record<string, unknown> | null,
		colClocks: Record<string, string>,
		hlc: string,
		opType: string,
		payload: Record<string, unknown> | null,
	): Promise<void>;
	getOpsSince(since: string, tables: string[]): Promise<OpLogEntry[]>;
	/**
	 * Distinct table names with ops newer than `since`, restricted to `tables`.
	 *
	 * Resume only needs the set of changed tables — it re-executes each affected
	 * query and sends a snapshot rather than replaying ops. Without this,
	 * resume loads every op row since the watermark into memory just to collect
	 * distinct names, which is unbounded for a long-offline client.
	 *
	 * Optional — the handler falls back to `getOpsSince` when absent.
	 */
	getChangedTablesSince?(since: string, tables: string[]): Promise<string[]>;
	/**
	 * Highest op-log HLC across `tables`, or null when the log is empty.
	 *
	 * HA polling uses it as a cheap "did anything change at all" probe: without
	 * it, every poll tick re-executes every query for every subscriber group
	 * even when there were zero writes. Optional.
	 */
	getOplogHead?(tables: string[]): Promise<string | null>;
	deleteOpsBefore(hlc: string): Promise<number>;
	/**
	 * Atomic reserve-or-detect-replay: returns true if this opId was fresh
	 * (inserted), false if it was already reserved. MUST be implemented as a
	 * single atomic operation (e.g. INSERT ... ON CONFLICT DO NOTHING) — a
	 * non-atomic check-then-write race-conditions in HA setups where multiple
	 * instances share storage and double-applies the op.
	 */
	reserveOp(opId: string): Promise<boolean>;
	/**
	 * Batch form of `reserveOp`: returns the subset of `opIds` that were fresh.
	 * Must be atomic per id, like `reserveOp`. Optional — the handler falls
	 * back to one `reserveOp` per op.
	 */
	reserveOps?(opIds: string[]): Promise<string[]>;
	getMeta(key: string): Promise<string | null>;
	setMeta(key: string, value: string): Promise<void>;
	/**
	 * Acquire a cross-instance lock (e.g. Postgres pg_advisory_lock).
	 * Returns true if acquired, false if another instance holds it.
	 * Optional — handler runs best-effort if absent.
	 */
	tryLock?(key: string): Promise<boolean>;
	unlock?(key: string): Promise<void>;
}

/**
 * Adapters already warned about a missing `applyOp`. Per-adapter rather than
 * per-process: a process-wide flag means the second non-atomic adapter never
 * warns, so a real crash-safety gap ships silently.
 */
const applyOpShimWarned = new WeakSet<StorageAdapter>();

/**
 * Return an adapter that is guaranteed to have `applyOp`.
 *
 * Built-in adapters (postgres, sqlite) ship an atomic one and are returned
 * unchanged. An adapter without it gets a *wrapper* — the caller's object is
 * never mutated, so passing the same adapter to two servers (or asserting on it
 * in a test) sees exactly what it constructed — plus a one-time warning that
 * a crash between `putRow` and `appendOp` can diverge the row store from the
 * op log.
 */
export function ensureAtomicApplyOp(adapter: StorageAdapter): StorageAdapter {
	if (adapter.applyOp) return adapter;
	if (!applyOpShimWarned.has(adapter)) {
		applyOpShimWarned.add(adapter);
		console.warn(
			"[reflectdb] StorageAdapter lacks atomic applyOp; using non-atomic shim. " +
				"Crash between putRow and appendOp can diverge. " +
				"Implement StorageAdapter.applyOp for crash safety.",
		);
	}
	// Every method is forwarded explicitly rather than spread: a spread copies
	// only own enumerable properties, which silently drops the prototype methods
	// of a class-based adapter. Forwarding also keeps `this` bound to the
	// original, so adapters holding private fields keep working.
	const wrapper: StorageAdapter = {
		getRow: (...args) => adapter.getRow(...args),
		putRow: (...args) => adapter.putRow(...args),
		getRows: (...args) => adapter.getRows(...args),
		appendOp: (...args) => adapter.appendOp(...args),
		getOpsSince: (...args) => adapter.getOpsSince(...args),
		deleteOpsBefore: (...args) => adapter.deleteOpsBefore(...args),
		reserveOp: (...args) => adapter.reserveOp(...args),
		getMeta: (...args) => adapter.getMeta(...args),
		setMeta: (...args) => adapter.setMeta(...args),
		applyOp: async (table, rowId, row, colClocks, hlc, opType, payload) => {
			await adapter.putRow(table, rowId, row, colClocks, hlc);
			await adapter.appendOp({ table, op: opType, rowId, payload, hlc, colClocks });
		},
	};
	// Optional methods are forwarded only when present — an always-defined
	// stub would make callers take the fast path into a `undefined` call.
	if (adapter.getRowsByIds) {
		wrapper.getRowsByIds = (...args) => adapter.getRowsByIds!(...args);
	}
	if (adapter.getChangedTablesSince) {
		wrapper.getChangedTablesSince = (...args) => adapter.getChangedTablesSince!(...args);
	}
	if (adapter.getOplogHead) {
		wrapper.getOplogHead = (...args) => adapter.getOplogHead!(...args);
	}
	if (adapter.reserveOps) {
		wrapper.reserveOps = (...args) => adapter.reserveOps!(...args);
	}
	if (adapter.tryLock) {
		wrapper.tryLock = (...args) => adapter.tryLock!(...args);
	}
	if (adapter.unlock) {
		wrapper.unlock = (...args) => adapter.unlock!(...args);
	}
	return wrapper;
}

export class MessageHandler<TAuth extends AuthContext = AuthContext> {
	private transport: ServerTransport;
	private serverId: string;
	private db: unknown;
	private clock: ServerClock;
	private sessions: SessionManager<TAuth>;
	private authCallback: AuthCallback | null = null;
	private queries = new Map<string, QueryRegistration>();
	private rooms: RoomRegistration[] = [];
	private rateLimiter: RateLimiter | null = null;
	private maxBatchSize: number = MAX_BATCH_SIZE;
	private storage: StorageAdapter | null = null;
	private minSchemaVersion = 0;
	private messageQueues = new Map<string, Promise<void>>();
	private resultCache = new ResultCache();
	private broadcast: BroadcastEngine<TAuth>;
	private ops: OpProcessor<TAuth>;
	private ephemeralManager = new EphemeralManager();
	private ephemeralCleanupTimer: ReturnType<typeof setInterval> | null = null;
	private eagerBuffer = new EagerBuffer();
	private replay: ReplayDetector;
	private static readonly MAX_EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;
	// Short-lived cache so ops re-auth doesn't hit the auth callback on every
	// push (hot path under high write rate). 5s is short enough to honor token
	// revocation within a normal request lifecycle but long enough to absorb
	// a burst of ops messages from one client.
	private static readonly AUTH_CACHE_TTL_MS = 5_000;
	private authCache = new Map<string, { auth: AuthContext; expiresAt: number }>();
	private compaction: CompactionManager;
	private messageQueueDepths = new Map<string, number>();
	private static readonly MAX_QUEUE_DEPTH = 100;
	private static eagerWarned = false;
	private static missingAuthWarned = false;
	/** Highest op-log HLC observed by the HA poll loop. */
	private pollWatermark: string | null = null;
	private onEvent: ((event: SyncEvent) => void) | null = null;
	private maxConnectionsPerUser: number | null = null;
	private allowAnonymous = false;
	private queryTimeoutMs = 0;
	private ephemeralPerSecond: number = DEFAULT_EPHEMERAL_PER_SECOND;
	private ephemeralBuckets = new Map<string, { count: number; resetAt: number }>();

	// Reverse index: tableName → Set of query names that depend on it
	private tableDependencyIndex = new Map<string, Set<string>>();

	private emit(event: SyncEvent): void {
		try {
			this.onEvent?.(event);
		} catch {
			// Observer errors must not crash the handler
		}
	}

	/**
	 * Send that never throws. Transports now REPORT delivery failure (so the
	 * broadcast engine can withhold its result-cache commit), which means every
	 * send site that must keep running afterwards — disconnect handshakes, acks,
	 * per-client fanout — has to opt out of the throw explicitly.
	 *
	 * Returns false when the frame did not reach the client.
	 */
	private async trySend(
		clientId: string,
		message: Parameters<ServerTransport["send"]>[1],
	): Promise<boolean> {
		try {
			await this.transport.send(clientId, message);
			return true;
		} catch (err) {
			console.warn(
				`[reflectdb] send to ${clientId} failed (${message.type}):`,
				err instanceof Error ? err.message : err,
			);
			return false;
		}
	}

	constructor(config: HandlerConfig) {
		this.transport = config.transport;
		this.serverId = config.serverId;
		this.db = config.db;
		this.onEvent = config.onEvent ?? null;
		this.maxConnectionsPerUser = config.maxConnectionsPerUser ?? null;
		this.allowAnonymous = config.allowAnonymous ?? false;
		this.queryTimeoutMs = config.queryTimeoutMs ?? 0;
		this.clock = new ServerClock(`server:${config.serverId}`);
		this.sessions = new SessionManager<TAuth>();
		this.compaction = new CompactionManager(null, (e) => this.emit(e));
		this.replay = new ReplayDetector(null);

		this.broadcast = new BroadcastEngine<TAuth>({
			sessions: this.sessions,
			queries: this.queries,
			tableDependencyIndex: this.tableDependencyIndex,
			resultCache: this.resultCache,
			send: (clientId, message) => this.transport.send(clientId, message),
			executeQuery: (reg, session, limit) => this.executeQuery(reg, session, limit),
			countQuery: (reg, session) => this.countQuery(reg, session),
			nextHlc: () => this.clock.stamp(),
			emit: (event) => this.emit(event),
			queryTimeoutMs: this.queryTimeoutMs,
			maxGroupConcurrency: config.maxBroadcastConcurrency ?? 8,
		});

		this.ops = new OpProcessor<TAuth>({
			db: this.db,
			queries: this.queries,
			sessions: this.sessions,
			eagerBuffer: this.eagerBuffer,
			replay: this.replay,
			getStorage: () => this.storage,
			getRateLimiter: () => this.rateLimiter,
			getMaxBatchSize: () => this.maxBatchSize,
			stampHlc: () => this.clock.stamp(),
			// Advance past the incoming op so subsequent server-stamped
			// broadcasts stay monotonic relative to applied client ops.
			receiveClientHlc: (hlc) => this.clock.receive(hlc),
			send: (clientId, message) => this.transport.send(clientId, message),
			broadcastChanges: (table, excludeClientId) => this.broadcastChanges(table, excludeClientId),
		});

		this.transport.onConnect((clientId) => {
			this.sessions.connect(clientId);
			this.emit({ type: "client_connected", clientId });
		});

		this.transport.onDisconnect((clientId) => {
			this.sessions.disconnect(clientId);
			this.messageQueues.delete(clientId);
			this.messageQueueDepths.delete(clientId);
			this.resultCache.clearClient(clientId);
			this.ephemeralManager.removeClient(clientId);
			this.ephemeralBuckets.delete(clientId);
			this.emit({ type: "client_disconnected", clientId });
		});

		this.transport.onMessage((clientId, rawMessage) => {
			// Validate message structure before processing
			const validation = validateClientMessage(rawMessage);
			if (!validation.valid) {
				console.warn(`[reflectdb] Invalid message from ${clientId}: ${validation.error}`);
				this.emit({ type: "message_invalid", clientId, error: validation.error });
				return;
			}
			const message = validation.message;

			// Backpressure: reject if too many messages are queued
			const depth = this.messageQueueDepths.get(clientId) ?? 0;
			if (depth >= MessageHandler.MAX_QUEUE_DEPTH) {
				this.emit({ type: "queue_overflow", clientId, depth });
				// Drain in-flight queue first so any acks for already-processed
				// ops reach the client before we disconnect. Otherwise the client
				// times out waiting for acks of work the server actually did,
				// reconnects, and re-pushes — relying on reserveOp idempotency
				// to prevent double-apply but still wasting a round trip.
				const inflight = this.messageQueues.get(clientId) ?? Promise.resolve();
				inflight
					.catch(() => {})
					.then(() =>
						this.transport
							.send(clientId, {
								type: "disconnect",
								reason: "Message queue overflow",
							})
							.catch(() => {
								/* best-effort */
							}),
					)
					.then(() => this.transport.disconnect?.(clientId))
					.finally(() => {
						this.sessions.disconnect(clientId);
						this.messageQueues.delete(clientId);
						this.messageQueueDepths.delete(clientId);
						this.resultCache.clearClient(clientId);
						this.ephemeralBuckets.delete(clientId);
					});
				return;
			}
			this.messageQueueDepths.set(clientId, depth + 1);

			// Serialize message processing per client
			const prev = this.messageQueues.get(clientId) ?? Promise.resolve();
			const next = prev
				.then(() =>
					this.handleMessage(clientId, message).catch((err) => {
						console.error(`Error handling message from ${clientId}:`, err);
					}),
				)
				.finally(() => {
					const current = this.messageQueueDepths.get(clientId);
					if (current !== undefined) {
						this.messageQueueDepths.set(clientId, current - 1);
					}
				});
			this.messageQueues.set(clientId, next);
		});

		// Start ephemeral cleanup timer
		this.ephemeralCleanupTimer = setInterval(() => {
			this.ephemeralManager.cleanupExpired();
		}, 5_000);

		// Surface eager-buffer flush failures so operators can wire a DLQ /
		// alert path instead of relying on log scraping.
		this.eagerBuffer.setOnFlushError((err, op) => {
			this.emit({
				type: "eager_flush_failed",
				table: op.entry.table,
				rowId: op.entry.rowId,
				error: err,
			});
		});
	}

	setAuth(callback: AuthCallback): void {
		this.authCallback = callback;
	}

	setQuery(name: string, registration: QueryRegistration): void {
		// Validate callback shape at registration time so a malformed query
		// fails loudly here instead of later inside an op-handling try/catch.
		if (typeof registration.callback !== "function") {
			throw new TypeError(`[reflectdb] Query "${name}": callback must be a function`);
		}
		const opts = registration.options;
		if (opts.mutate !== undefined && typeof opts.mutate !== "function") {
			throw new TypeError(
				`[reflectdb] Query "${name}": options.mutate must be a function or undefined`,
			);
		}
		if (opts.authorize !== undefined && typeof opts.authorize !== "function") {
			throw new TypeError(
				`[reflectdb] Query "${name}": options.authorize must be a function or undefined`,
			);
		}

		this.queries.set(name, registration);

		// Update reverse dependency index
		for (const tableName of registration.tableDependencies) {
			let queryNames = this.tableDependencyIndex.get(tableName);
			if (!queryNames) {
				queryNames = new Set();
				this.tableDependencyIndex.set(tableName, queryNames);
			}
			queryNames.add(name);
		}

		// Start the eager buffer timer when the first eager query is registered.
		// "eager-durable" persists inline when storage is configured, but falls
		// back to the buffer when it isn't — so it needs a running drain too.
		if (
			registration.options.broadcast === "eager" ||
			registration.options.broadcast === "eager-durable"
		) {
			this.eagerBuffer.start(registration.options.flushInterval);
		}
		if (registration.options.broadcast === "eager") {
			if (!MessageHandler.eagerWarned) {
				MessageHandler.eagerWarned = true;
				console.warn(
					`[reflectdb] Query "${name}" uses broadcast: "eager" — at-most-once across server crash for the oplog. ` +
						`Use "eager-durable" unless your mutate hook writes durably to the user DB and you can tolerate resume-via-snapshot.`,
				);
			}
		}
	}

	setRoom(registration: RoomRegistration): void {
		this.rooms.push(registration);
	}

	setRateLimiter(limiter: RateLimiter): void {
		this.rateLimiter = limiter;
	}

	/** Per-client ephemeral message ceiling per second. 0 disables metering. */
	setEphemeralRateLimit(perSecond: number): void {
		this.ephemeralPerSecond = perSecond;
	}

	setMaxBatchSize(size: number): void {
		this.maxBatchSize = size;
	}

	setMaxEphemeralEntries(max: number): void {
		this.ephemeralManager = new EphemeralManager(max);
	}

	setMinSchemaVersion(version: number): void {
		this.minSchemaVersion = version;
	}

	setMaxConnectionsPerUser(max: number | null): void {
		this.maxConnectionsPerUser = max;
	}

	private async enforceConnectionCap(userId: string, newClientId: string): Promise<void> {
		if (!this.maxConnectionsPerUser || this.maxConnectionsPerUser <= 0) return;
		while (this.sessions.countForUser(userId) > this.maxConnectionsPerUser) {
			const oldest = this.sessions.oldestForUser(userId);
			if (!oldest || oldest.clientId === newClientId) break;
			await this.trySend(oldest.clientId, {
				type: "disconnect",
				reason: "Connection limit exceeded",
			});
			try {
				await this.transport.disconnect?.(oldest.clientId);
			} catch {
				// best-effort
			}
			this.sessions.disconnect(oldest.clientId);
			this.messageQueues.delete(oldest.clientId);
			this.messageQueueDepths.delete(oldest.clientId);
			this.resultCache.clearClient(oldest.clientId);
			this.ephemeralManager.removeClient(oldest.clientId);
			this.ephemeralBuckets.delete(oldest.clientId);
		}
	}

	setStorage(adapter: StorageAdapter): void {
		this.storage = ensureAtomicApplyOp(adapter);
		this.eagerBuffer.setStorage(this.storage);
		this.compaction.setStorage(this.storage);
		this.replay.setStorage(this.storage);
		// Recover the clock before the first message is served.
		this.clock.setStorage(this.storage);
	}

	/**
	 * Re-read the shared HLC watermark and merge it into this instance's clock.
	 * The HA poll loop calls this each tick; expose it so deployments driving
	 * their own loop can keep instances converged too.
	 */
	async syncClockWatermark(): Promise<void> {
		await this.clock.refresh();
	}

	getSessions(): SessionManager<TAuth> {
		return this.sessions;
	}

	getResultCache(): ResultCache {
		return this.resultCache;
	}

	private async handleMessage(clientId: string, message: ClientMessage): Promise<void> {
		// Recover the persisted clock before stamping anything. Resolved after
		// the first call, so this is a microtask on the hot path.
		await this.clock.ensureLoaded();

		// Centralized auth gate: all message types except hello/auth require an authenticated session
		if (message.type !== "hello" && message.type !== "auth") {
			const session = this.sessions.get(clientId);
			if (!session || !session.auth) {
				// trySend, not send: a failed notice must not skip the disconnect.
				await this.trySend(clientId, {
					type: "disconnect",
					reason: "Not authenticated",
				});
				await this.transport.disconnect?.(clientId);
				return;
			}
		}

		switch (message.type) {
			case "hello":
				await this.handleHello(clientId, message);
				break;
			case "auth":
				await this.handleAuth(clientId, message);
				break;
			case "bootstrap":
				await this.handleBootstrap(clientId, message);
				break;
			case "resume":
				await this.handleResume(clientId, message);
				break;
			case "ops":
				await this.handleOps(clientId, message);
				break;
			case "sync_declare":
				await this.handleSyncDeclare(clientId, message);
				break;
			case "load_more":
				await this.handleLoadMore(clientId, message);
				break;
			case "unsync":
				await this.handleUnsync(clientId, message);
				break;
			case "ephemeral":
				await this.handleEphemeral(clientId, message as EphemeralMessage);
				break;
		}
	}

	private async handleHello(
		clientId: string,
		message: Extract<ClientMessage, { type: "hello" }>,
	): Promise<void> {
		// Negotiate the highest version that both peers support. Fall back to
		// the client's declared protocolVersion when it omits supportedVersions
		// (older clients). Reject only when no overlap exists.
		const clientVersions = message.supportedVersions ?? [message.protocolVersion];
		const negotiated = [...SUPPORTED_PROTOCOL_VERSIONS]
			.sort((a, b) => b - a)
			.find((v) => clientVersions.includes(v));

		if (negotiated == null) {
			await this.trySend(clientId, {
				type: "hello_reject",
				reason: `Unsupported protocol version: ${message.protocolVersion}`,
				supported: [...SUPPORTED_PROTOCOL_VERSIONS],
			});
			return;
		}

		// No auth callback and no explicit opt-in to anonymous access: every
		// later message would fail the "Not authenticated" gate while `hello`
		// still acked, so the server looks alive but is unusable. Fail the
		// handshake loudly instead of silently accepting it.
		if (!this.authCallback && !this.allowAnonymous) {
			if (!MessageHandler.missingAuthWarned) {
				MessageHandler.missingAuthWarned = true;
				console.error(
					"[reflectdb] No auth() callback registered. Every message after `hello` " +
						"would be rejected as unauthenticated. Call server.auth(fn), or pass " +
						"`allowAnonymous: true` to createServer for an unauthenticated server.",
				);
			}
			await this.trySend(clientId, {
				type: "hello_reject",
				reason: "Server has no auth() configured",
				supported: [...SUPPORTED_PROTOCOL_VERSIONS],
			});
			await this.transport.disconnect?.(clientId);
			return;
		}

		// Authenticate
		if (this.authCallback) {
			try {
				const req = new Request("https://sync/hello", {
					headers: { authorization: `Bearer ${message.token}` },
				});
				const auth = (await this.authCallback(req)) as TAuth;
				this.sessions.setAuth(clientId, auth);
				await this.enforceConnectionCap(auth.userId, clientId);
			} catch (err) {
				console.error(`[reflectdb] Auth callback failed for client ${clientId}:`, err);
				this.emit({ type: "auth_failed", clientId, error: err });
				await this.trySend(clientId, {
					type: "hello_reject",
					reason: "Authentication failed",
					supported: [PROTOCOL_VERSION],
				});
				return;
			}
		} else {
			// allowAnonymous: give the session a stable synthetic identity so
			// rate limiting, connection caps and room callbacks still key on
			// something. Never reachable without the opt-in above.
			this.sessions.setAuth(clientId, { userId: `anon:${clientId}` } as TAuth);
		}

		await this.trySend(clientId, {
			type: "hello_ack",
			protocolVersion: negotiated,
			serverId: this.serverId,
		});
	}

	private async handleAuth(
		clientId: string,
		message: Extract<ClientMessage, { type: "auth" }>,
	): Promise<void> {
		if (!this.authCallback) return;

		try {
			const req = new Request("https://sync/auth", {
				headers: { authorization: `Bearer ${message.token}` },
			});
			const auth = (await this.authCallback(req)) as TAuth;
			this.sessions.setAuth(clientId, auth);
			await this.enforceConnectionCap(auth.userId, clientId);
		} catch (err) {
			console.error(`[reflectdb] Auth callback failed for client ${clientId} (re-auth):`, err);
			this.emit({ type: "auth_failed", clientId, error: err });
			await this.trySend(clientId, {
				type: "disconnect",
				reason: "Authentication failed",
			});
			// Force-close so an adversarial client can't keep using the revoked
			// session by ignoring the message. Falls back to send-only on
			// transports that don't implement disconnect.
			await this.transport.disconnect?.(clientId);
		}
	}

	private async handleBootstrap(
		clientId: string,
		_message: Extract<ClientMessage, { type: "bootstrap" }>,
	): Promise<void> {
		const session = this.sessions.get(clientId);
		if (!session) return;

		// Flush eager buffer so pending ops are visible in queries
		await this.eagerBuffer.flush();

		// Send snapshot for each subscribed query
		for (const [queryName, sub] of session.subscriptions) {
			const queryReg = this.queries.get(queryName);
			if (!queryReg) continue;

			const isWindowed = sub.windowSize != null && sub.windowSize > 0;

			let rows: Record<string, unknown>[];
			let totalCount: number | undefined;

			try {
				if (isWindowed) {
					const windowed = await this.fetchWindow(queryReg, session, sub.windowLimit);
					rows = windowed.rows;
					totalCount = windowed.totalCount;
					sub.loadedCount = rows.length;
					sub.lastTotalCount = totalCount;
				} else {
					rows = await this.executeQuery(queryReg, session);
				}
			} catch (err) {
				console.error(
					`[reflectdb] Query "${queryName}" failed during bootstrap for client ${clientId}:`,
					err,
				);
				rows = [];
			}

			// Build colClocks from rows
			const pk = queryReg.options.pk ?? "id";
			const colClocks: Record<string, Record<string, string>> = {};
			const hlcStr = this.clock.packed();
			for (const row of rows) {
				const rowId = String(row[pk] ?? "");
				if (rowId) {
					colClocks[rowId] = { _row: hlcStr };
				}
			}

			// Commit the cache only after the snapshot actually reached the
			// client. Committing first would make the next broadcast diff
			// against rows the client never received, so the rows would never
			// be re-sent.
			const delivered = await this.trySend(clientId, {
				type: "snapshot",
				table: queryName,
				rows,
				colClocks,
				totalCount,
				pk,
			});
			if (delivered) {
				this.resultCache.set(clientId, queryName, rows, pk);
				sub.bootstrapped = true;
			}
		}

		// Send bootstrap_complete with query metadata
		const tableMeta: Record<
			string,
			{
				serverSet: string[];
				readonly: string[];
				broadcast: "consistent" | "eager" | "eager-durable";
				pk: string;
			}
		> = {};
		for (const [queryName] of session.subscriptions) {
			const queryReg = this.queries.get(queryName);
			tableMeta[queryName] = {
				serverSet: queryReg?.options.serverSet ? Object.keys(queryReg.options.serverSet) : [],
				readonly: queryReg?.options.readonly ?? [],
				broadcast: queryReg?.options.broadcast ?? "consistent",
				pk: queryReg?.options.pk ?? "id",
			};
		}

		const hlcStr = this.clock.stamp();
		this.sessions.updateWatermark(clientId, hlcStr);

		this.emit({ type: "bootstrap", clientId, queries: session.subscriptions.size });

		await this.trySend(clientId, {
			type: "bootstrap_complete",
			serverHlc: hlcStr,
			tableMeta,
		});
	}

	/**
	 * Execute a query registration's callback for a given client session.
	 * Falls back to storage when no application DB is configured.
	 *
	 * @param limit — max rows the caller needs. Passed to the callback as
	 *   `ctx.limit` so it can push the cap into SQL (`.limit(ctx.limit)`), and
	 *   ALSO applied as a JS slice afterwards. The slice is the safety net for
	 *   callbacks that ignore `ctx.limit` — without it, the server would have
	 *   to choose between clobbering a user-defined `.limit()`/`.offset()` and
	 *   returning more rows than the window holds.
	 */
	private async executeQuery(
		queryReg: QueryRegistration,
		session: ClientSession<TAuth>,
		limit?: number,
	): Promise<Record<string, unknown>[]> {
		let rows: Record<string, unknown>[];

		if (this.db) {
			const sub = session.subscriptions.get(queryReg.name);
			const ctx = { auth: session.auth!, params: sub?.params ?? {}, limit };

			const query = queryReg.callback(ctx, this.db);
			// Drizzle queries are thenable — await them to execute
			const result = await (query as Promise<unknown>);
			rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
		} else {
			rows = [];
		}

		if (limit != null && rows.length > limit) {
			return rows.slice(0, limit);
		}
		return rows;
	}

	/**
	 * Total row count for count hints, using the query's `count` callback.
	 * Returns null when the query has none — callers then fall back to the
	 * length of a full result set.
	 */
	private async countQuery(
		queryReg: QueryRegistration,
		session: ClientSession<TAuth>,
	): Promise<number | null> {
		const countFn = queryReg.options.count;
		if (!countFn || !this.db) return null;
		const sub = session.subscriptions.get(queryReg.name);
		const ctx = { auth: session.auth!, params: sub?.params ?? {} };
		return await countFn(ctx, this.db);
	}

	/**
	 * Fetch one window of a query plus the total row count.
	 *
	 * With a `count` callback the fetch is capped at the window size and the
	 * total comes from `count` — a 50-row window over a million-row table reads
	 * 50 rows. Without one, the server must materialize the full result set to
	 * know the total, so windowing only saves bytes on the wire.
	 */
	private async fetchWindow(
		queryReg: QueryRegistration,
		session: ClientSession<TAuth>,
		windowSize: number,
	): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
		if (queryReg.options.count) {
			const [rows, counted] = await Promise.all([
				this.executeQuery(queryReg, session, windowSize),
				this.countQuery(queryReg, session),
			]);
			return { rows, totalCount: counted ?? rows.length };
		}
		const allRows = await this.executeQuery(queryReg, session);
		return { rows: allRows.slice(0, windowSize), totalCount: allRows.length };
	}

	private async handleResume(
		clientId: string,
		message: Extract<ClientMessage, { type: "resume" }>,
	): Promise<void> {
		const session = this.sessions.get(clientId);
		if (!session) return;

		// Flush eager buffer so pending ops are in the op log before we query it
		await this.eagerBuffer.flush();

		// Load persisted compaction cutoff (once) before checking
		await this.compaction.ensureCutoffLoaded();
		const cutoffHlc = this.compaction.getCutoff();

		// Reject if the client's watermark is older than the compaction cutoff
		if (cutoffHlc && message.since < cutoffHlc) {
			await this.trySend(clientId, {
				type: "resume_rejected",
				reason: "compacted",
				serverHlc: this.clock.peekNext(),
			});
			return;
		}

		// Determine which database tables have changes since the watermark
		const changedDbTables = new Set<string>();
		if (this.storage) {
			const allDepTablesSet = new Set<string>();
			for (const [queryName] of session.subscriptions) {
				const reg = this.queries.get(queryName);
				if (reg) {
					for (const dep of reg.tableDependencies) {
						allDepTablesSet.add(dep);
					}
				}
			}
			const allDepTables = [...allDepTablesSet];
			try {
				// Only the distinct table names matter here — resume re-runs the
				// affected queries and snapshots. Pulling every op row since the
				// watermark just to read `.table` is unbounded work for a client
				// that has been offline a long time.
				if (this.storage.getChangedTablesSince) {
					const tables = await this.storage.getChangedTablesSince(message.since, allDepTables);
					for (const t of tables) changedDbTables.add(t);
				} else {
					const ops = await this.storage.getOpsSince(message.since, allDepTables);
					for (const op of ops) changedDbTables.add(op.table);
				}
			} catch {
				// Op log unavailable — fall back to re-executing all queries
				for (const t of allDepTables) changedDbTables.add(t);
			}
		}

		// For each subscribed query that depends on a changed table,
		// re-execute the query and send a snapshot. This ensures tenant
		// filtering from the query callback is applied (unlike raw op replay).
		const hlcStr = this.clock.packed();
		for (const [queryName, sub] of session.subscriptions) {
			const queryReg = this.queries.get(queryName);
			if (!queryReg) continue;

			// Skip queries whose tables haven't changed
			const hasChanges =
				changedDbTables.size === 0 ||
				[...queryReg.tableDependencies].some((t) => changedDbTables.has(t));
			if (!hasChanges) continue;

			const isWindowed = sub.windowSize != null && sub.windowSize > 0;

			try {
				let rows: Record<string, unknown>[];
				let totalCount: number | undefined;

				if (isWindowed) {
					const windowed = await this.fetchWindow(queryReg, session, sub.windowLimit);
					rows = windowed.rows;
					totalCount = windowed.totalCount;
					sub.loadedCount = rows.length;
					sub.lastTotalCount = totalCount;
				} else {
					rows = await this.executeQuery(queryReg, session);
				}

				const pk = queryReg.options.pk ?? "id";
				const colClocks: Record<string, Record<string, string>> = {};
				for (const row of rows) {
					const rowId = String(row[pk] ?? "");
					if (rowId) colClocks[rowId] = { _row: hlcStr };
				}

				// Commit the cache only after the snapshot landed — see
				// handleBootstrap for why the order matters.
				const delivered = await this.trySend(clientId, {
					type: "snapshot",
					table: queryName,
					rows,
					colClocks,
					totalCount,
					pk,
				});
				if (delivered) {
					this.resultCache.set(clientId, queryName, rows, pk);
					sub.bootstrapped = true;
				}
			} catch (err) {
				console.error(
					`[reflectdb] Query "${queryName}" failed during resume for client ${clientId}:`,
					err,
				);
			}
		}

		const resumeHlc = this.clock.stamp();
		this.sessions.updateWatermark(clientId, resumeHlc);

		this.emit({
			type: "resume",
			clientId,
			queries: session.subscriptions.size,
			tablesChanged: changedDbTables.size,
		});

		await this.trySend(clientId, {
			type: "resume_complete",
			serverHlc: resumeHlc,
		});
	}

	private async handleOps(
		clientId: string,
		message: Extract<ClientMessage, { type: "ops" }>,
	): Promise<void> {
		const session = this.sessions.get(clientId);
		if (!session) return;

		// Re-auth per op push (design decision #8) with short-lived token cache
		// to avoid running the auth callback on every batch under high write
		// rates. Cache hit reuses prior auth without hitting the callback.
		if (this.authCallback) {
			try {
				const cached = this.authCache.get(message.token);
				let auth: TAuth;
				const now = Date.now();
				if (cached && cached.expiresAt > now) {
					auth = cached.auth as TAuth;
				} else {
					const req = new Request("https://sync/ops", {
						headers: { authorization: `Bearer ${message.token}` },
					});
					auth = (await this.authCallback(req)) as TAuth;
					this.authCache.set(message.token, {
						auth,
						expiresAt: now + MessageHandler.AUTH_CACHE_TTL_MS,
					});
					// Eviction: drop expired first, then FIFO if still over cap.
					// Without the FIFO fallback the cap is broken — when all
					// entries are fresh the expired-only sweep finds nothing
					// and the map grows unbounded.
					if (this.authCache.size > 1000) {
						for (const [k, v] of this.authCache) {
							if (v.expiresAt <= now) this.authCache.delete(k);
						}
						if (this.authCache.size > 1000) {
							const drop = this.authCache.size - 1000;
							const iter = this.authCache.keys();
							for (let n = 0; n < drop; n++) {
								const k = iter.next().value;
								if (k === undefined) break;
								this.authCache.delete(k);
							}
						}
					}
				}
				this.sessions.setAuth(clientId, auth);
			} catch (err) {
				console.error(`[reflectdb] Auth callback failed for client ${clientId} (ops push):`, err);
				this.emit({ type: "auth_failed", clientId, error: err });
				await this.trySend(clientId, {
					type: "reauth",
				});
				return;
			}
		}

		const accepted: string[] = [];
		const rejected: Array<{
			opId: string;
			batchId?: string;
			reason: ErrorReason;
			serverRow?: Record<string, unknown> | null;
		}> = [];

		// Track failed batchIds: any subsequent op with the same batchId must
		// be rejected to preserve batch atomicity. Independent ops (no batchId)
		// or ops in different batches keep going.
		const failedBatchIds = new Map<string, ErrorReason>();

		// Collect affected tables across all ops in the batch to broadcast once at the end
		const deferredBroadcastTables = new Set<string>();

		// One round trip each for replay reservation and existing rows, instead
		// of two per op. A 100-op batch used to issue 100 reserveOp inserts and
		// 100 getRow selects sequentially before it could start writing.
		const batch = await this.ops.prefetchBatch(message.ops);

		for (const op of message.ops) {
			if (op.batchId && failedBatchIds.has(op.batchId)) {
				rejected.push({
					opId: op.id,
					batchId: op.batchId,
					reason: failedBatchIds.get(op.batchId)!,
				});
				continue;
			}

			const result = await this.ops.processClientOp(op, session, deferredBroadcastTables, batch);
			if (result.accepted) {
				accepted.push(op.id);
			} else {
				const reason = result.reason ?? "server_error";
				rejected.push({
					opId: op.id,
					batchId: op.batchId,
					reason,
					serverRow: result.serverRow,
				});
				if (op.batchId) {
					failedBatchIds.set(op.batchId, reason);
				}
			}
		}

		// Broadcast once per unique affected table after all ops are processed
		for (const table of deferredBroadcastTables) {
			await this.broadcastChanges(table, session.clientId);
		}

		this.emit({
			type: "ops_processed",
			clientId,
			accepted: accepted.length,
			rejected: rejected.length,
		});

		// Send acks
		if (accepted.length > 0) {
			await this.trySend(clientId, {
				type: "ack",
				opIds: accepted,
			});
		}

		// Send rejects in parallel — each has unique opId so ordering doesn't matter
		if (rejected.length > 0) {
			await Promise.all(
				rejected.map((rej) =>
					this.trySend(clientId, {
						type: "reject",
						opId: rej.opId,
						batchId: rej.batchId,
						reason: rej.reason,
						serverRow: rej.serverRow ?? undefined,
					}),
				),
			);
		}
	}

	/**
	 * After a write to a table, find all queries that depend on that table,
	 * re-execute them per subscriber group, and send deltas for any changes.
	 * See `BroadcastEngine` for grouping, locking and windowing behavior.
	 */
	private async broadcastChanges(
		tableName: string,
		excludeClientId: string,
		overrideRoomKey?: string | null,
	): Promise<void> {
		await this.broadcast.broadcastChanges(tableName, excludeClientId, overrideRoomKey);
	}

	private async handleSyncDeclare(
		clientId: string,
		message: Extract<ClientMessage, { type: "sync_declare" }>,
	): Promise<void> {
		const session = this.sessions.get(clientId);
		if (!session) return;

		// The "table" field in sync_declare is the query name
		const queryReg = this.queries.get(message.table);
		if (!queryReg) {
			await this.trySend(clientId, {
				type: "reject",
				opId: `sync_declare:${message.table}`,
				reason: "unknown_query",
			});
			return;
		}

		const resolved = resolveRoomKey(this.rooms, message.params ?? {}, queryReg.options.room);
		if (!resolved.ok) {
			console.warn(
				`[reflectdb] sync_declare for "${message.table}" from ${clientId} rejected: ${resolved.reason}`,
			);
			await this.trySend(clientId, {
				type: "reject",
				opId: `sync_declare:${message.table}`,
				reason: "outside_shape",
			});
			return;
		}
		const roomKey = resolved.roomKey;

		if (roomKey) {
			for (const room of this.rooms) {
				const match = room.regex.exec(roomKey);
				if (match) {
					const params: Record<string, string> = {};
					for (let i = 0; i < room.paramNames.length; i++) {
						params[room.paramNames[i]!] = match[i + 1]!;
					}
					const cbResult = await room.callback({ params, auth: session.auth! });
					if (cbResult && !cbResult.ok) {
						await this.trySend(clientId, {
							type: "disconnect",
							reason: cbResult.reason ?? "Room access denied",
						});
						await this.transport.disconnect?.(clientId);
						return;
					}
					break;
				}
			}
		}

		// Authorize read access
		if (queryReg.options.authorize) {
			const ctx: MutationContext = {
				auth: session.auth!,
				params: message.params ?? {},
			};
			try {
				await (
					queryReg.options.authorize as (
						action: AuthorizeAction,
						ctx: MutationContext,
						db: unknown,
					) => Promise<void>
				)({ type: "read", table: message.table, params: message.params ?? {} }, ctx, this.db);
			} catch (err) {
				const reason = reasonFromError(err);
				await this.trySend(clientId, {
					type: "reject",
					opId: `sync_declare:${message.table}`,
					reason,
				});
				return;
			}
		}

		this.sessions.subscribe(
			clientId,
			message.table,
			message.params ?? {},
			queryReg.options,
			roomKey,
			message.window ?? null,
		);
	}

	private async handleLoadMore(clientId: string, message: LoadMoreMessage): Promise<void> {
		const session = this.sessions.get(clientId);
		if (!session) return;

		const sub = session.subscriptions.get(message.table);
		if (!sub || sub.windowSize == null) return;

		const queryReg = this.queries.get(message.table);
		if (!queryReg) return;

		const prevLoaded = sub.loadedCount;
		// The window grows by `count`, independent of how many rows the client
		// actually holds — asking for 20 more when only 5 of 50 arrived must
		// widen the entitlement to 70, not to 25.
		const newLimit = sub.windowLimit + message.count;

		// Fetch only the new window when we can count separately; otherwise the
		// full result set is the only way to know the total.
		let totalCount = 0;
		let rows: Record<string, unknown>[];
		try {
			if (queryReg.options.countHints && !queryReg.options.count) {
				const allRows = await this.executeQuery(queryReg, session);
				rows = allRows.slice(0, newLimit);
				totalCount = allRows.length;
			} else {
				rows = await this.executeQuery(queryReg, session, newLimit);
				if (queryReg.options.countHints) {
					totalCount = (await this.countQuery(queryReg, session)) ?? rows.length;
				}
			}
		} catch (err) {
			console.error(
				`[reflectdb] Query "${message.table}" failed during loadMore for client ${clientId}:`,
				err,
			);
			return;
		}

		// The new rows are those beyond what we previously loaded
		const newRows = rows.slice(prevLoaded);
		const pk = queryReg.options.pk ?? "id";

		let delivered = true;
		if (newRows.length > 0) {
			const colClocks: Record<string, Record<string, string>> = {};
			const hlcStr = this.clock.packed();
			for (const row of newRows) {
				const rowId = String(row[pk] ?? "");
				if (rowId) {
					colClocks[rowId] = { _row: hlcStr };
				}
			}

			delivered = await this.trySend(clientId, {
				type: "snapshot",
				table: message.table,
				rows: newRows,
				colClocks,
				append: true,
				pk,
			});
		}

		// Commit cache + window position only if the client got the page. On a
		// dropped send, leaving both untouched makes the next broadcast diff
		// re-emit the missing rows.
		if (delivered) {
			// Always update cache to current window (fixes stale cache after empty loadMore)
			this.resultCache.set(clientId, message.table, rows, pk);
			sub.loadedCount = rows.length;
			sub.windowLimit = newLimit;
		}

		// Send count_changed using the count resolved above
		if (queryReg.options.countHints) {
			if (totalCount !== sub.lastTotalCount) {
				const countDelivered = await this.trySend(clientId, {
					type: "count_changed",
					table: message.table,
					totalCount,
				});
				if (countDelivered) sub.lastTotalCount = totalCount;
			}
		}
	}

	private async handleUnsync(
		clientId: string,
		message: Extract<ClientMessage, { type: "unsync" }>,
	): Promise<void> {
		this.sessions.unsubscribe(clientId, message.table);
		this.resultCache.clear(clientId, message.table);
	}

	/**
	 * Fixed-window bucket for ephemeral traffic, keyed per client. Separate from
	 * the op-path limiter so presence and writes don't starve each other.
	 */
	private allowEphemeral(clientId: string): boolean {
		if (this.ephemeralPerSecond <= 0) return true;
		const now = Date.now();
		const bucket = this.ephemeralBuckets.get(clientId);
		if (!bucket || now >= bucket.resetAt) {
			this.ephemeralBuckets.set(clientId, { count: 1, resetAt: now + 1000 });
			return true;
		}
		if (bucket.count >= this.ephemeralPerSecond) return false;
		bucket.count++;
		return true;
	}

	private async handleEphemeral(clientId: string, message: EphemeralMessage): Promise<void> {
		const session = this.sessions.get(clientId);
		if (!session) return;

		// Ephemeral is the highest-frequency message in the protocol (cursors,
		// presence) and each one fans out to every room subscriber. Unmetered,
		// it is an amplification channel: one client's spam becomes N sends.
		// Its own bucket, always on — presence must not consume the write
		// budget, and the op-path limiter is opt-in while this must not be.
		if (!this.allowEphemeral(clientId)) {
			this.emit({ type: "ephemeral_rate_limited", clientId });
			return;
		}

		const { key, data } = message;
		// Clamp client-supplied TTL: a malicious client could pass Infinity or
		// MAX_SAFE_INTEGER and pin entries forever, blocking legitimate sets at
		// the ephemeral capacity ceiling.
		const ttlMs =
			typeof message.ttlMs === "number" && message.ttlMs > 0
				? Math.min(message.ttlMs, MessageHandler.MAX_EPHEMERAL_TTL_MS)
				: undefined;
		// Use the authenticated userId, not the client-supplied one
		const userId = session.auth!.userId;

		// Collect unique room keys from subscriptions
		const roomKeys = new Set<string>();
		const queryNames = new Set<string>();
		for (const [queryName, sub] of session.subscriptions) {
			queryNames.add(queryName);
			if (sub.roomKey) {
				roomKeys.add(sub.roomKey);
			}
		}

		const event = {
			type: "ephemeral" as const,
			key,
			clientId,
			userId,
			data,
			ttlMs,
		};

		// Send to all clients in the same room(s), or same queries if no rooms
		const sent = new Set<string>();
		const recipients: string[] = [];
		for (const roomKey of roomKeys) {
			const accepted = this.ephemeralManager.set(roomKey, key, clientId, userId, data, ttlMs);
			if (!accepted) {
				this.emit({ type: "ephemeral_full", currentSize: this.ephemeralManager.size });
				return;
			}
		}

		for (const queryName of queryNames) {
			// If sender has a room, scope to that room; otherwise broadcast to all subscribers
			const senderSub = session.subscriptions.get(queryName);
			const senderRoomKey = senderSub?.roomKey ?? null;
			const subscribers = this.sessions.getSubscribersForQuery(queryName, senderRoomKey);
			for (const sub of subscribers) {
				if (sub.clientId !== clientId && !sent.has(sub.clientId)) {
					sent.add(sub.clientId);
					recipients.push(sub.clientId);
				}
			}
		}

		// Fan out concurrently. Awaiting each recipient in turn makes one slow or
		// backpressured socket delay presence for everyone behind it — on the
		// highest-frequency message type in the protocol.
		await Promise.all(recipients.map((recipient) => this.trySend(recipient, event)));
	}

	// ── Compaction watermark (lazy-loaded from storage) ─────────────────

	// ── Replay detection ────────────────────────────────────────────────

	/** Public reserve-or-replay gate for REST idempotency. Returns true when fresh. */
	async reserveOpId(opId: string): Promise<boolean> {
		return this.replay.reserve(opId);
	}

	// ── Compaction ──────────────────────────────────────────────────────

	async runCompaction(minOpAge: number): Promise<number> {
		return this.compaction.runCompaction(minOpAge);
	}

	getEagerBuffer(): EagerBuffer {
		return this.eagerBuffer;
	}

	/**
	 * Returns all table names that have registered query dependencies.
	 * Used by the poll feature to know which tables to check for remote changes.
	 */
	getTrackedTables(): string[] {
		return [...this.tableDependencyIndex.keys()];
	}

	/**
	 * One HA poll tick: pick up writes made by other instances sharing storage.
	 *
	 * On an adapter that can report the op-log head, an idle tick costs a single
	 * `MAX(hlc)` query and broadcasts nothing. Re-running every query for every
	 * subscriber group on every tick — the naive version — is ~5k queries/sec at
	 * idle for 500 clients on a 100ms poll.
	 *
	 * Also re-merges the shared clock watermark, so an instance whose wall clock
	 * lags its peers stops stamping writes below HLCs clients have already seen.
	 */
	async pollRemoteChanges(): Promise<void> {
		await this.clock.refresh();

		const tables = this.getTrackedTables();
		if (tables.length === 0) return;

		const storage = this.storage;
		if (!storage?.getOplogHead || !storage.getChangedTablesSince) {
			// No change-detection support — fall back to notifying everything.
			await this.notifyAll(tables);
			return;
		}

		const head = await storage.getOplogHead(tables);
		if (this.pollWatermark === null) {
			// First tick: adopt the current head rather than replaying history.
			// An empty log starts at "" so the very first write is still seen.
			this.pollWatermark = head ?? "";
			return;
		}
		if (head === null || head <= this.pollWatermark) return;

		const changed = await storage.getChangedTablesSince(this.pollWatermark, tables);
		this.pollWatermark = head;
		await this.notifyAll(changed);
	}

	/** Broadcast several tables, isolating per-table failures from each other. */
	private async notifyAll(tables: string[]): Promise<void> {
		const results = await Promise.allSettled(tables.map((table) => this.notifyChange(table)));
		for (let i = 0; i < results.length; i++) {
			const r = results[i]!;
			if (r.status === "rejected") {
				console.error(`[reflectdb] poll notifyChange for "${tables[i]}" failed:`, r.reason);
			}
		}
	}

	/**
	 * Notify that a table changed from an external source (e.g. REST).
	 * Triggers delta broadcasting to connected sync clients.
	 *
	 * @param roomKey — restrict broadcast to subscribers in this room. Pass
	 *   null to broadcast cross-room (the default; legacy behavior). For
	 *   multi-tenant apps, pass the tenant's room key to avoid leaking
	 *   row-level changes across tenants.
	 */
	async notifyChange(tableName: string, roomKey?: string | null): Promise<void> {
		await this.clock.ensureLoaded();
		await this.broadcastChanges(tableName, "", roomKey);
	}

	/**
	 * Apply a server-originated write (e.g. REST endpoint) through the same
	 * HLC stamping + op log + broadcast path as sync ops. Previously REST
	 * wrote with `hlc: ""`, bypassing the op log entirely — resume would
	 * miss the write and divergence would accumulate.
	 *
	 * Ordering matches the sync-consistent pipeline: stamp HLC, run user
	 * authorize/mutate (via `execute`), then atomic sync-storage write and
	 * broadcast. If `execute` throws, sync storage is untouched.
	 */
	async applyServerOp(
		op: { type: OpType; table: string; rowId: string; payload: Record<string, unknown> | null },
		execute?: (stamped: {
			type: OpType;
			table: string;
			rowId: string;
			payload: Record<string, unknown> | null;
			hlc: string;
		}) => Promise<void>,
		options?: {
			/**
			 * Restrict change broadcast to subscribers in this room. Without
			 * this, the broadcast goes to ALL subscribers of the affected
			 * query — leaking writes across tenant boundaries. Pass null to
			 * intentionally broadcast cross-room (legacy behavior).
			 */
			roomKey?: string | null;
		},
	): Promise<{ hlc: string; resolvedRow: Record<string, unknown> | null }> {
		await this.clock.ensureLoaded();
		let hlcStr = this.clock.stamp();

		let resolvedRow: Record<string, unknown> | null;
		const colClocks: Record<string, string> = {};

		// Multi-instance HLC catch-up: if storage already has the row at a
		// higher HLC (another instance wrote since our last sendHlc), advance
		// our clock past it so our stamp wins. REST writes are authoritative
		// (LWW), so we want to overwrite — but with a fresh HLC > existing,
		// not a stale one that would later look like causality going backwards.
		let existingRow: Record<string, unknown> | null = null;
		let existingColClocks: Record<string, string> = {};
		if (this.storage) {
			const existing = await this.storage.getRow(op.table, op.rowId);
			existingRow = existing.row;
			existingColClocks = existing.colClocks;
			if (existing.rowHlc && hlcStr <= existing.rowHlc) {
				try {
					this.clock.receive(existing.rowHlc);
					hlcStr = this.clock.packed();
				} catch {
					// Malformed stored HLC — leave hlcStr as-is. The clobber
					// risk is no worse than not having this catch-up at all.
				}
			}
		}

		if (op.type === "delete" || op.payload === null) {
			resolvedRow = null;
			for (const key of Object.keys(existingColClocks)) {
				colClocks[key] = hlcStr;
			}
		} else if (op.type === "insert") {
			// INSERT replaces the row (REST POST semantics). Merging would
			// leak unrelated columns from a prior row that happened to share
			// the same id — surprising for callers who think "POST means new".
			resolvedRow = { ...op.payload };
			for (const key of Object.keys(op.payload)) {
				colClocks[key] = hlcStr;
			}
		} else {
			// UPDATE merges with existing so a partial PATCH doesn't wipe
			// untouched columns. Preserve untouched cols' OLD HLCs so a
			// future older delta on those cols is correctly rejected as
			// stale (instead of winning against an empty colClock).
			const base = existingRow ?? {};
			resolvedRow = { ...base, ...op.payload };
			for (const [k, v] of Object.entries(existingColClocks)) {
				if (k !== "_row") colClocks[k] = v;
			}
			for (const key of Object.keys(op.payload)) {
				colClocks[key] = hlcStr;
			}
		}
		colClocks._row = hlcStr;

		// Run user-provided authorize + mutate BEFORE touching sync storage
		// so a failure leaves sync state and user DB both untouched.
		if (execute) {
			await execute({ ...op, hlc: hlcStr });
		}

		if (this.storage) {
			await this.storage.applyOp!(
				op.table,
				op.rowId,
				resolvedRow,
				colClocks,
				hlcStr,
				op.type,
				op.payload,
			);
		}

		await this.broadcastChanges(op.table, "", options?.roomKey);

		return { hlc: hlcStr, resolvedRow };
	}

	async close(): Promise<void> {
		if (this.ephemeralCleanupTimer) {
			clearInterval(this.ephemeralCleanupTimer);
		}
		// Persist the clock before shutdown so the next boot resumes above
		// every HLC this instance stamped.
		await this.clock.close();
		// Drain in-flight per-client message queues so handlers don't run
		// against torn-down state after close resolves. allSettled ignores
		// already-rejected chains.
		const inflight = [...this.messageQueues.values()];
		if (inflight.length > 0) {
			await Promise.allSettled(inflight);
		}
		this.messageQueues.clear();
		this.messageQueueDepths.clear();
		this.ephemeralManager.destroy();
		await this.eagerBuffer.close();
	}
}
