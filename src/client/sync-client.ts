import type {
	ClientOp,
	ClientTransport,
	ErrorReason,
	ServerMessage,
	OpType,
	EphemeralEvent,
} from "../core/types.ts";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, MAX_BATCH_SIZE } from "../core/types.ts";
import { receiveHlc, unpackHlc } from "../core/hlc.ts";
import type { HLC } from "../core/hlc.ts";

import { createOpCreator } from "./ops.ts";
import type { OpCreator } from "./ops.ts";
import { ClientStore } from "./store.ts";
import type { ClientStorageAdapter } from "./storage/types.ts";

export interface SyncClientConfig {
	clientId: string;
	transport: ClientTransport;
	token: string;
	storage?: ClientStorageAdapter;
	onSync?: (table: string) => void;
	/**
	 * Structured error callback. `reason` is drawn from the protocol's
	 * ErrorReason taxonomy when the error originates server-side; local
	 * failures (reauth/transport) use a "local:*" namespace so consumers
	 * can switch on the string.
	 */
	onError?: (error: { opId?: string; batchId?: string; table?: string; reason: ErrorReason | `local:${string}`; message?: string }) => void;
	onReauth?: () => Promise<string>;
	/** Max reconnect backoff in ms (before jitter). Default: 30_000. */
	maxReconnectDelayMs?: number;
	/**
	 * Load every stored row at boot instead of only the tables this client is
	 * subscribed to. Needed only if you read rows for a table before calling
	 * `sync()` on it. Default: false.
	 */
	hydrateAllTables?: boolean;
}

export type SyncClientState =
	| "hydrating"
	| "disconnected"
	| "connecting"
	| "connected"
	| "bootstrapping"
	| "synced";

export interface SyncOptions {
	window?: number;
}

export class SyncClient {
	private config: SyncClientConfig;
	private transport: ClientTransport;
	private opCreator: OpCreator;
	private store: ClientStore;
	private state: SyncClientState = "disconnected";
	/** Version agreed on in hello_ack. Null until first successful handshake. */
	private negotiatedProtocolVersion: number | null = null;
	private syncedTables = new Set<string>();
	private serverHlc: string | null = null;
	private listeners = new Set<() => void>();
	private version = 0;
	private tableVersions = new Map<string, number>();
	private tableListeners = new Map<string, Set<() => void>>();
	private connectResolve: (() => void) | null = null;
	private connectReject: ((err: Error) => void) | null = null;
	private connectInFlight: Promise<void> | null = null;
	private ephemeralListeners = new Map<string, Set<(event: EphemeralEvent) => void>>();
	private totalCounts = new Map<string, number>();
	private syncOptions = new Map<string, SyncOptions>();
	private bootstrapScheduled = false;
	private initialized = false;
	private syncParams = new Map<string, Record<string, unknown> | undefined>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private closed = false;
	/**
	 * Ops already transmitted, mapped to when they were sent. Without this,
	 * every mutation re-sends the whole pending set: 50 rapid edits before the
	 * first ack land as 1+2+…+50 = 1275 ops on the wire, each one a `reserveOp`
	 * insert server-side. Cleared on disconnect so a reconnect resends them.
	 */
	private inFlightOps = new Map<string, number>();
	/**
	 * How long an op may sit unacked before a later push retries it. A frame can
	 * be dropped without the connection dying — a full server-side queue, for
	 * one — and without this the op would stay marked in-flight, never re-sent,
	 * until the connection happens to drop. Resends are idempotent server-side.
	 */
	private static readonly IN_FLIGHT_TTL_MS = 30_000;
	/** Tail of the serialized push chain; also the coalescing slot. */
	private pushChain: Promise<void> = Promise.resolve();
	private pushPending: Promise<void> | null = null;

	constructor(config: SyncClientConfig) {
		this.config = config;
		this.transport = config.transport;
		this.opCreator = createOpCreator(`client:${config.clientId}`);
		this.store = new ClientStore(config.storage);

		this.transport.subscribe((message) => {
			this.handleMessage(message);
		});
	}

	// ── Initialization (hydration from durable storage) ─────────────────

	async init(): Promise<void> {
		if (!this.config.storage) {
			this.initialized = true;
			return;
		}

		this.state = "hydrating";
		this.notify();

		// Restore sync subscriptions BEFORE hydrating so we can scope the row
		// read to the tables this client actually subscribes to. Rows only
		// reach storage through a subscription (and `unsync` clears them), so
		// nothing reachable is skipped — but an app with ten tables and two
		// subscriptions no longer reads all ten at boot.
		const subsJson = await this.config.storage.getMeta("syncSubscriptions");
		if (subsJson) {
			const subs = JSON.parse(subsJson) as Array<{
				table: string;
				params?: Record<string, unknown>;
				options?: SyncOptions;
			}>;
			for (const sub of subs) {
				this.syncedTables.add(sub.table);
				if (sub.params) {
					this.syncParams.set(sub.table, sub.params);
				}
				if (sub.options) {
					this.syncOptions.set(sub.table, sub.options);
				}
			}
		}

		await this.store.hydrate(
			this.config.hydrateAllTables || this.syncedTables.size === 0
				? undefined
				: { tables: [...this.syncedTables] },
		);

		// Restore serverHlc
		const serverHlcStr = await this.config.storage.getMeta("serverHlc");
		if (serverHlcStr) {
			this.serverHlc = serverHlcStr;
		}

		// Restore HLC state (prevents clock regression). Always use the current
		// clientId's nodeId — a persisted nodeId from a prior session must not
		// leak into ops stamped by this client, or the server can't distinguish
		// origins.
		const currentNodeId = `client:${this.config.clientId}`;
		const hlcJson = await this.config.storage.getMeta("hlcState");
		let restoredHlc: HLC | null = null;
		if (hlcJson) {
			const parsed = JSON.parse(hlcJson) as HLC;
			restoredHlc = { ...parsed, nodeId: currentNodeId };
			this.opCreator = createOpCreator(currentNodeId, restoredHlc);
		}

		// Advance HLC past any pending ops to prevent clock regression
		// (pending ops may have been created after the last hlcState persist)
		const pendingOps = this.store.getPendingOps();
		if (pendingOps.length > 0) {
			let maxMs = restoredHlc?.ms ?? 0;
			let maxCounter = restoredHlc?.counter ?? 0;
			for (const p of pendingOps) {
				const opHlc = unpackHlc(p.op.hlc);
				if (opHlc.ms > maxMs || (opHlc.ms === maxMs && opHlc.counter > maxCounter)) {
					maxMs = opHlc.ms;
					maxCounter = opHlc.counter;
				}
			}
			this.opCreator = createOpCreator(currentNodeId, {
				ms: maxMs,
				counter: maxCounter,
				nodeId: currentNodeId,
			});
		}

		this.state = "disconnected";
		this.initialized = true;
		this.notify();
	}

	// ── Connection Lifecycle ─────────────────────────────────────────────

	async connect(): Promise<void> {
		if (!this.initialized && this.config.storage) {
			await this.init();
		}

		// If a connect is already in flight, return its promise instead of
		// firing a second hello + replacing the resolve handle (which would
		// orphan the first awaiter).
		if (this.connectInFlight) return this.connectInFlight;

		this.state = "connecting";

		this.connectInFlight = new Promise<void>((resolve, reject) => {
			this.connectResolve = resolve;
			this.connectReject = reject;
		}).finally(() => {
			this.connectInFlight = null;
		});

		await this.transport.send({
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
			clientId: this.config.clientId,
			token: this.config.token,
		});

		return this.connectInFlight;
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.state = "disconnected";
		this.notify();
		// Drain pending storage writes before tearing down transport so a quick
		// app exit (e.g. tab close after a mutation) doesn't lose unflushed
		// writes silently.
		try {
			await this.store.flush();
		} catch (err) {
			console.error("[reflectdb] store flush during close failed:", err);
		}
		await this.transport.close();
	}

	getState(): SyncClientState {
		return this.state;
	}

	/** Version negotiated with the server. Null before the first hello_ack. */
	getProtocolVersion(): number | null {
		return this.negotiatedProtocolVersion;
	}

	// ── Sync Control (design decision #9: explicit sync) ────────────────

	async sync(
		table: string,
		params?: Record<string, unknown>,
		options?: SyncOptions,
	): Promise<void> {
		this.syncedTables.add(table);
		if (params) {
			this.syncParams.set(table, params);
		}
		if (options) {
			this.syncOptions.set(table, options);
		}
		this.persistSyncSubscriptions();

		await this.transport.send({
			type: "sync_declare",
			table,
			params,
			window: options?.window,
		});
	}

	async loadMore(table: string, count: number): Promise<void> {
		await this.transport.send({
			type: "load_more",
			table,
			count,
		});
	}

	getTotalCount(table: string): number | null {
		return this.totalCounts.get(table) ?? null;
	}

	async unsync(table: string): Promise<void> {
		this.syncedTables.delete(table);
		this.syncOptions.delete(table);
		this.syncParams.delete(table);
		this.totalCounts.delete(table);
		this.store.clearTable(table);
		this.persistSyncSubscriptions();
		this.notify([table]);

		await this.transport.send({
			type: "unsync",
			table,
		});
	}

	async bootstrap(): Promise<void> {
		this.state = "bootstrapping";
		await this.transport.send({
			type: "bootstrap",
		});
	}

	/**
	 * Schedule a bootstrap in the next microtask.
	 * Multiple calls within the same tick are coalesced into one bootstrap.
	 */
	scheduleBootstrap(): void {
		if (this.bootstrapScheduled) return;
		this.bootstrapScheduled = true;
		queueMicrotask(() => {
			this.bootstrapScheduled = false;
			this.bootstrap();
		});
	}

	async resume(): Promise<void> {
		if (!this.serverHlc) {
			return this.bootstrap();
		}

		await this.transport.send({
			type: "resume",
			since: this.serverHlc,
		});
	}

	// ── Data Operations ─────────────────────────────────────────────────

	insert(table: string, rowId: string, payload: Record<string, unknown>): ClientOp {
		const op = this.opCreator.insert(table, rowId, payload);
		this.store.addPendingOp(op);
		this.store.applyOptimistic(op);
		this.notify([table]);
		return op;
	}

	update(table: string, rowId: string, payload: Record<string, unknown>): ClientOp {
		const op = this.opCreator.update(table, rowId, payload);
		this.store.addPendingOp(op);
		this.store.applyOptimistic(op);
		this.notify([table]);
		return op;
	}

	delete(table: string, rowId: string): ClientOp {
		const op = this.opCreator.delete(table, rowId);
		this.store.addPendingOp(op);
		this.store.applyOptimistic(op);
		this.notify([table]);
		return op;
	}

	batch(
		ops: Array<{
			table: string;
			op: OpType;
			rowId: string;
			payload: Record<string, unknown> | null;
		}>,
	): ClientOp[] {
		const batchOps = this.opCreator.createBatch(ops);
		for (const op of batchOps) {
			this.store.addPendingOp(op);
			this.store.applyOptimistic(op);
		}
		this.notify([...new Set(batchOps.map((o) => o.table))]);
		return batchOps;
	}

	// ── Push Pending Ops ────────────────────────────────────────────────

	/**
	 * Transmit pending ops.
	 *
	 * Concurrent calls are coalesced: at most one push runs and at most one
	 * more is queued behind it, so a burst of mutations (every `useSync`
	 * mutation calls this) produces one send per op rather than one send of
	 * everything pending per mutation. The returned promise resolves once the
	 * caller's own ops have been handed to the transport.
	 */
	push(): Promise<void> {
		if (this.pushPending) return this.pushPending;
		const run = this.pushChain.catch(() => {}).then(() => {
			// Clear before running so a push issued *during* this one queues
			// behind it instead of joining it and missing its own ops.
			this.pushPending = null;
			return this.doPush();
		});
		this.pushPending = run;
		this.pushChain = run.catch(() => {});
		return run;
	}

	private async doPush(): Promise<void> {
		// Flush storage writes before sending (write-ahead guarantee)
		await this.store.flush();

		// Skip ops already on the wire — the server acks or rejects each one,
		// and reserveOp makes a resend idempotent but not free. Anything older
		// than the TTL is retried: its ack may simply never be coming.
		const cutoff = Date.now() - SyncClient.IN_FLIGHT_TTL_MS;
		const pending = this.store.getPendingOps().filter((p) => {
			const sentAt = this.inFlightOps.get(p.op.id);
			return sentAt === undefined || sentAt <= cutoff;
		});
		if (pending.length === 0) return;

		const ops = pending.map((p) => p.op);

		// Pre-compute the contiguous run-length of each batchId at every index
		// so we can avoid splitting a batch across chunks. Server's
		// failedBatchIds set is local to one handleOps call — splitting a
		// batch would let the later chunk land independently and break
		// batch atomicity.
		//
		// We assume same-batchId ops are contiguous in the pending list
		// (createBatch enforces this, and addPendingOp appends in order).
		// The walk preserves original order — never reorders a non-batch op
		// past a batch sibling.
		const chunks: ClientOp[][] = [];
		let current: ClientOp[] = [];
		let i = 0;
		while (i < ops.length) {
			const op = ops[i]!;
			if (op.batchId) {
				let end = i + 1;
				while (end < ops.length && ops[end]!.batchId === op.batchId) end++;
				const batchOps = ops.slice(i, end);
				if (batchOps.length > MAX_BATCH_SIZE) {
					// Single batch larger than the cap: flush current, send the
					// oversize batch as its own message. Server rejects with
					// batch_too_large, which is the correct signal to the app.
					if (current.length > 0) {
						chunks.push(current);
						current = [];
					}
					chunks.push(batchOps);
				} else {
					if (current.length + batchOps.length > MAX_BATCH_SIZE) {
						chunks.push(current);
						current = [];
					}
					current.push(...batchOps);
				}
				i = end;
			} else {
				if (current.length + 1 > MAX_BATCH_SIZE) {
					chunks.push(current);
					current = [];
				}
				current.push(op);
				i++;
			}
		}
		if (current.length > 0) chunks.push(current);

		for (const chunk of chunks) {
			const chunkIds = chunk.map((op) => op.id);
			const sentAt = Date.now();
			for (const id of chunkIds) this.inFlightOps.set(id, sentAt);
			try {
				await this.transport.send({
					type: "ops",
					ops: chunk,
					token: this.config.token,
				});
			} catch (err) {
				// Never delivered — drop the in-flight marks so the next push
				// (or the reconnect re-push) sends them again.
				for (const id of chunkIds) this.inFlightOps.delete(id);
				throw err;
			}
		}
	}

	/** Forget which ops are on the wire — used when the connection drops. */
	private clearInFlight(): void {
		this.inFlightOps.clear();
	}

	// ── Ephemeral Messages ──────────────────────────────────────────────

	async sendEphemeral(params: {
		key: string;
		userId: string;
		data: Record<string, unknown>;
		ttlMs?: number;
	}): Promise<void> {
		await this.transport.send({
			type: "ephemeral",
			...params,
		});
	}

	subscribeEphemeral(key: string, listener: (event: EphemeralEvent) => void): () => void {
		let listeners = this.ephemeralListeners.get(key);
		if (!listeners) {
			listeners = new Set();
			this.ephemeralListeners.set(key, listeners);
		}

		listeners.add(listener);

		return () => {
			listeners!.delete(listener);
			if (listeners!.size === 0) {
				this.ephemeralListeners.delete(key);
			}
		};
	}

	// ── Query Local State ───────────────────────────────────────────────

	getRows(table: string, options?: { includeDeleted?: boolean }): Record<string, unknown>[] {
		return this.store.getRows(table, options?.includeDeleted).map((r) => r.data!);
	}

	getRow(table: string, rowId: string): Record<string, unknown> | null {
		const row = this.store.getRow(table, rowId);
		return row?.data ?? null;
	}

	getPendingCount(): number {
		return this.store.getPendingOps().length;
	}

	getStore(): ClientStore {
		return this.store;
	}

	/**
	 * Subscribe to store changes. Returns an unsubscribe function.
	 * Compatible with React's useSyncExternalStore.
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Subscribe to changes for a specific table. Returns an unsubscribe function.
	 * More efficient than subscribe() — only fires when the given table changes.
	 */
	subscribeTable(table: string, listener: () => void): () => void {
		let listeners = this.tableListeners.get(table);
		if (!listeners) {
			listeners = new Set();
			this.tableListeners.set(table, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners!.delete(listener);
			if (listeners!.size === 0) {
				this.tableListeners.delete(table);
			}
		};
	}

	/** Returns a version number that increments on every data change. */
	getVersion(): number {
		return this.version;
	}

	/** Returns a version number for a specific table. Only increments when that table changes. */
	getTableVersion(table: string): number {
		return this.tableVersions.get(table) ?? 0;
	}

	private notify(tables?: string[]): void {
		this.version++;

		if (tables) {
			for (const table of tables) {
				this.tableVersions.set(table, (this.tableVersions.get(table) ?? 0) + 1);
				const tableListeners = this.tableListeners.get(table);
				if (tableListeners) {
					// Snapshot to allow listeners to unsubscribe during iteration.
					// Catch per-listener so one buggy subscriber can't break fanout.
					for (const listener of [...tableListeners]) {
						try {
							listener();
						} catch (err) {
							console.error("[reflectdb] table listener threw:", err);
						}
					}
				}
			}
		}

		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch (err) {
				console.error("[reflectdb] listener threw:", err);
			}
		}
	}

	// ── Full Reset (logout) ─────────────────────────────────────────────

	/**
	 * Reset client state. With no argument, wipes everything (pending ops,
	 * rows, server HLC, subscriptions). With `tables`, only those tables'
	 * rows + subscriptions are dropped — useful for logging out of a single
	 * scope or evicting a stale dataset without losing pending ops elsewhere.
	 */
	async clear(opts?: { tables?: string[] }): Promise<void> {
		if (opts?.tables && opts.tables.length > 0) {
			for (const table of opts.tables) {
				await this.store.clearTable(table);
				this.syncedTables.delete(table);
				this.syncOptions.delete(table);
				this.syncParams.delete(table);
				this.totalCounts.delete(table);
			}
			this.notify();
			return;
		}

		await this.store.clear();
		this.serverHlc = null;
		this.syncedTables.clear();
		this.syncOptions.clear();
		this.syncParams.clear();
		this.totalCounts.clear();
		this.opCreator = createOpCreator(`client:${this.config.clientId}`);
		this.clearInFlight();
		this.state = "disconnected";
		this.initialized = false;
		this.notify();
	}

	// ── Message Handling ────────────────────────────────────────────────

	private handleMessage(message: ServerMessage): void {
		switch (message.type) {
			case "hello_ack":
				// Server picks the highest shared version. Store so callers
				// and future feature flags can branch on capability.
				if (!SUPPORTED_PROTOCOL_VERSIONS.includes(message.protocolVersion)) {
					this.state = "disconnected";
					this.connectReject?.(
						new Error(`Server negotiated unsupported version: ${message.protocolVersion}`),
					);
					this.connectResolve = null;
					this.connectReject = null;
					this.notify();
					break;
				}
				this.negotiatedProtocolVersion = message.protocolVersion;
				this.state = "connected";
				this.connectResolve?.();
				this.connectResolve = null;
				this.connectReject = null;
				this.notify();
				break;

			case "hello_reject":
				this.state = "disconnected";
				this.connectReject?.(new Error(message.reason));
				this.connectResolve = null;
				this.connectReject = null;
				this.notify();
				this.config.onError?.({ reason: "local:hello_rejected", message: message.reason });
				break;

			case "snapshot":
				this.store.applySnapshot(
					message.table,
					message.rows,
					message.colClocks,
					message.append,
					message.pk,
				);
				if (message.totalCount != null) {
					this.totalCounts.set(message.table, message.totalCount);
				}
				this.notify([message.table]);
				this.config.onSync?.(message.table);
				break;

			case "bootstrap_complete":
				this.serverHlc = message.serverHlc;
				this.store.setTableMeta(message.tableMeta);
				this.state = "synced";
				this.mergeServerHlc(message.serverHlc);
				this.persistMeta();
				this.notify();
				break;

			case "resume_complete":
				this.serverHlc = message.serverHlc;
				this.state = "synced";
				this.mergeServerHlc(message.serverHlc);
				this.persistMeta();
				this.notify();
				break;

			case "delta":
				this.store.applyDelta(
					message.table,
					message.op,
					message.rowId,
					message.payload,
					message.hlc,
					message.colClocks,
				);
				this.notify([message.table]);
				this.config.onSync?.(message.table);
				break;

			case "ack": {
				// Resolve affected tables before markSynced removes the ops
				const idSet = new Set(message.opIds);
				const ackedTables = [
					...new Set(
						this.store
							.getPendingOps()
							.filter((p) => idSet.has(p.op.id))
							.map((p) => p.op.table),
					),
				];
				for (const opId of message.opIds) this.inFlightOps.delete(opId);
				this.store.markSynced(message.opIds);
				this.notify(ackedTables.length > 0 ? ackedTables : undefined);
				break;
			}

			case "reject": {
				const rejectedTables: string[] = [];
				if (message.opId) {
					this.inFlightOps.delete(message.opId);
					const pending = this.store.getPendingOps().find((p) => p.op.id === message.opId);
					if (pending) rejectedTables.push(pending.op.table);
					this.store.markRejected(message.opId, message.reason);
					this.store.revertOp(message.opId, message.serverRow ?? null);
				}
				if (message.batchId) {
					// Snapshot ops before mutation so we can revert each one. Without
					// revert, optimistic state stays applied for batch-rejected ops.
					const batchOpIds: string[] = [];
					for (const p of this.store.getPendingOps()) {
						if (p.op.batchId === message.batchId) {
							rejectedTables.push(p.op.table);
							batchOpIds.push(p.op.id);
						}
					}
					this.store.rejectBatch(message.batchId, message.reason);
					for (const opId of batchOpIds) {
						this.inFlightOps.delete(opId);
						this.store.revertOp(opId, null);
					}
				}
				const uniqueRejectedTables = [...new Set(rejectedTables)];
				this.notify(uniqueRejectedTables.length > 0 ? uniqueRejectedTables : undefined);
				this.config.onError?.({
					opId: message.opId,
					reason: message.reason,
				});
				break;
			}

			case "resume_rejected":
				// Server's oplog was compacted past our watermark — clear the
				// stale watermark before bootstrap so a disconnect mid-bootstrap
				// can't resume against the same compacted HLC and loop.
				this.serverHlc = null;
				if (this.config.storage) {
					this.config.storage.setMeta("serverHlc", "").catch((err) => {
						console.error("[reflectdb] Failed to clear stale serverHlc:", err);
					});
				}
				this.bootstrap();
				break;

			case "reauth":
				this.handleReauth();
				break;

			case "disconnect":
				this.state = "disconnected";
				// Anything unacked never made it (or its ack never will) —
				// let the reconnect re-push resend it.
				this.clearInFlight();
				// Reject pending connect() if still waiting for hello_ack
				if (this.connectReject) {
					this.connectReject(new Error(message.reason));
					this.connectResolve = null;
					this.connectReject = null;
				}
				this.notify();
				this.config.onError?.({ reason: "local:disconnected", message: message.reason });
				this.scheduleReconnect();
				break;

			case "shape_changed":
				this.store.clearTable(message.table);
				this.notify([message.table]);
				this.config.onSync?.(message.table);
				break;

			case "count_changed":
				this.totalCounts.set(message.table, message.totalCount);
				this.notify([message.table]);
				break;

			case "ephemeral":
				{
					const listeners = this.ephemeralListeners.get(message.key);
					if (listeners) {
						for (const listener of listeners) {
							listener(message);
						}
					}
				}
				break;
		}
	}

	private mergeServerHlc(packed: string): void {
		const remote = unpackHlc(packed);
		const localHlc = this.opCreator.getHlc();
		const merged = receiveHlc(localHlc, remote);
		this.opCreator = createOpCreator(localHlc.nodeId, merged);
	}

	private persistMeta(): void {
		if (!this.config.storage) return;
		const storage = this.config.storage;

		// Fire-and-forget meta writes
		const hlcState = this.opCreator.getHlc();
		storage.setMeta("serverHlc", this.serverHlc!).catch((err) => {
			console.error("[reflectdb] Failed to persist serverHlc:", err);
		});
		storage.setMeta("hlcState", JSON.stringify(hlcState)).catch((err) => {
			console.error("[reflectdb] Failed to persist hlcState:", err);
		});
	}

	private persistSyncSubscriptions(): void {
		if (!this.config.storage) return;
		const subs = Array.from(this.syncedTables).map((table) => ({
			table,
			params: this.syncParams.get(table),
			options: this.syncOptions.get(table),
		}));
		this.config.storage.setMeta("syncSubscriptions", JSON.stringify(subs)).catch((err) => {
			console.error("[reflectdb] Failed to persist sync subscriptions:", err);
		});
	}

	private handleReauth(): void {
		if (!this.config.onReauth) {
			// Server asked for reauth but the app has no handler. Surface so the
			// app can decide to disconnect instead of silently working with a
			// stale token until the next failure.
			this.config.onError?.({
				reason: "local:reauth_failed",
				message: "reauth requested but no onReauth handler configured",
			});
			return;
		}
		this.config
			.onReauth()
			.then(async (token) => {
				this.config.token = token;
				try {
					await this.transport.send({ type: "auth", token });
				} catch (err) {
					this.config.onError?.({
						reason: "local:reauth_failed",
						message: `auth send failed: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			})
			.catch((err) => {
				this.config.onError?.({ reason: "local:reauth_failed", message: String(err) });
			});
	}

	// ── Reconnection ───────────────────────────────────────────────────

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer) return;

		// Exponential backoff with full jitter: halves base delay then adds
		// 0–base random, keeping the mean at base but decorrelating retries
		// across clients so a server restart doesn't get a thundering herd.
		const cap = this.config.maxReconnectDelayMs ?? 30000;
		const base = Math.min(1000 * 2 ** this.reconnectAttempts, cap);
		const delay = Math.round(base * (0.5 + Math.random() * 0.5));
		this.reconnectAttempts++;

		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			try {
				await this.connect();
				if (this.closed) return;

				// Re-subscribe all synced tables in parallel. allSettled so a single
				// rejected sync (e.g. authorize failure for one table) does not abort
				// resume + push for the rest of the session.
				if (this.closed) return;
				const syncResults = await Promise.allSettled(
					[...this.syncedTables].map((table) =>
						this.sync(table, this.syncParams.get(table), this.syncOptions.get(table)),
					),
				);
				for (const r of syncResults) {
					if (r.status === "rejected") {
						console.error("[reflectdb] reconnect re-sync failed:", r.reason);
					}
				}

				// Resume from last serverHlc or full bootstrap
				if (this.closed) return;
				await this.resume();

				// Fresh connection — nothing from the previous one is still on
				// the wire, so allow every pending op to be sent again.
				this.clearInFlight();

				// Re-push any pending ops
				if (this.closed) return;
				await this.push();

				// Only reset backoff after full sequence succeeds
				this.reconnectAttempts = 0;
			} catch (err) {
				try {
					this.config.onError?.({
						reason: "local:reconnect_failed",
						message: `attempt ${this.reconnectAttempts}: ${err instanceof Error ? err.message : String(err)}`,
					});
				} catch {
					// Don't let a buggy onError callback kill reconnection
				}
				this.scheduleReconnect();
			}
		}, delay);
	}
}

/**
 * Fire-and-forget push. Mutations call this from UI event handlers, so a
 * rejected transport send must not surface as an unhandled rejection — the
 * client re-pushes anything still pending on reconnect.
 */
export function pushSafely(client: SyncClient): Promise<void> {
	return client.push().catch((err) => {
		console.error("[reflectdb] push failed:", err);
	});
}
