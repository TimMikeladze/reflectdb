import { pushSafely, SyncClient } from "../client/sync-client.ts";
import type { SyncClientState } from "../client/sync-client.ts";
import type { ClientStorageAdapter } from "../client/storage/types.ts";
import type { ClientTransport, ClientMessage, ServerMessage, EphemeralEvent } from "../core/types.ts";

// ── Svelte store contract (no svelte runtime dependency) ────────────────

export interface Readable<T> {
	subscribe(cb: (value: T) => void): () => void;
}

// ── Browser WebSocket transport ─────────────────────────────────────────

export function createBrowserWsTransport(url: string): ClientTransport {
	let ws: WebSocket | null = null;
	let handler: ((message: ServerMessage) => void) | null = null;
	let intentionalClose = false;
	const sendQueue: ClientMessage[] = [];

	function ensureConnected(): WebSocket {
		if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
			return ws;
		}

		const socket = new WebSocket(url);
		socket.onopen = () => {
			for (const msg of sendQueue) {
				socket.send(JSON.stringify(msg));
			}
			sendQueue.length = 0;
		};
		socket.onmessage = (event) => {
			try {
				handler?.(JSON.parse(event.data as string));
			} catch (err) {
				console.warn(
					"[reflectdb] svelte WS: malformed message ignored:",
					err instanceof Error ? err.message : String(err),
				);
			}
		};
		socket.onclose = () => {
			ws = null;
			if (!intentionalClose) {
				handler?.({ type: "disconnect", reason: "transport_closed" });
			}
		};
		ws = socket;
		return socket;
	}

	return {
		async send(message: ClientMessage) {
			const socket = ensureConnected();
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(message));
			} else {
				sendQueue.push(message);
			}
		},
		subscribe(h: (message: ServerMessage) => void) {
			handler = h;
		},
		async close() {
			intentionalClose = true;
			if (ws) {
				ws.close();
				ws = null;
			}
		},
	};
}

// ── Config ──────────────────────────────────────────────────────────────

export interface SyncStoreConfig {
	url: string;
	token: string;
	tables?: string[];
	clientId?: string;
	storage?: ClientStorageAdapter;
	onReauth?: () => Promise<string>;
	onError?: (error: { opId?: string; reason: string }) => void;
}

// ── Store interface ─────────────────────────────────────────────────────

export interface SyncStore {
	client: SyncClient;
	status: Readable<SyncClientState>;
	pendingCount: Readable<number>;

	sync<T extends object = Record<string, unknown>>(
		table: string,
		options?: {
			params?: Record<string, unknown>;
			includeDeleted?: boolean;
			window?: number;
		},
	): {
		rows: Readable<T[]>;
		insert: (rowId: string, payload: Partial<T>) => void;
		update: (rowId: string, payload: Partial<T>) => void;
		remove: (rowId: string) => void;
	};

	row<T extends object = Record<string, unknown>>(
		table: string,
		rowId: string,
	): Readable<T | null>;

	ephemeral<T extends object>(config: {
		key: string;
		userId: string;
		ttlMs?: number;
	}): {
		events: Readable<Record<string, T>>;
		broadcast: (data: T) => Promise<void>;
		destroy: () => void;
	};

	totalCount(table: string): Readable<number | null>;
	loadMore(table: string, count: number): void;

	connect(): Promise<void>;
	close(): Promise<void>;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function stableKey(params?: Record<string, unknown>): string {
	if (!params) return "";
	return JSON.stringify(params, Object.keys(params).sort());
}

// ── Factory ─────────────────────────────────────────────────────────────

export function createSyncStore(config: SyncStoreConfig): SyncStore {
	const managedTables = new Set(config.tables ?? []);

	const clientId = config.clientId ?? `browser-${crypto.randomUUID().slice(0, 8)}`;
	const transport = createBrowserWsTransport(config.url);
	const client = new SyncClient({
		clientId,
		transport,
		token: config.token,
		storage: config.storage,
		onReauth: () =>
			config.onReauth?.() ?? Promise.reject(new Error("No onReauth handler")),
		onError: (err) => config.onError?.(err),
	});

	// Track unmanaged table subscriptions: table → subscriber count
	const unmanagedRefCounts = new Map<string, number>();
	// Track stable param keys to avoid redundant re-syncs
	const unmanagedParamKeys = new Map<string, string>();

	// ── status store ────────────────────────────────────────────────────

	const status: Readable<SyncClientState> = {
		subscribe(cb) {
			cb(client.getState());
			return client.subscribe(() => {
				cb(client.getState());
			});
		},
	};

	// ── pendingCount store ──────────────────────────────────────────────

	const pendingCount: Readable<number> = {
		subscribe(cb) {
			cb(client.getPendingCount());
			return client.subscribe(() => {
				cb(client.getPendingCount());
			});
		},
	};

	// ── sync (per-table reactive access) ────────────────────────────────

	function sync<T extends object = Record<string, unknown>>(
		table: string,
		options?: {
			params?: Record<string, unknown>;
			includeDeleted?: boolean;
			window?: number;
		},
	): {
		rows: Readable<T[]>;
		insert: (rowId: string, payload: Partial<T>) => void;
		update: (rowId: string, payload: Partial<T>) => void;
		remove: (rowId: string) => void;
	} {
		const isManaged = managedTables.has(table);
		const paramKey = stableKey(options?.params);

		const rows: Readable<T[]> = {
			subscribe(cb) {
				// Auto-sync unmanaged tables on first subscriber
				if (!isManaged) {
					const currentParamKey = unmanagedParamKeys.get(table);
					const count = unmanagedRefCounts.get(table) ?? 0;

					if (count === 0 || currentParamKey !== paramKey) {
						// Drop the previous subscription so the old paramKey
						// doesn't linger and double-deliver updates.
						if (currentParamKey !== undefined && currentParamKey !== paramKey) {
							client.unsync(table);
						}
						client.sync(
							table,
							options?.params,
							options?.window ? { window: options.window } : undefined,
						);
						client.scheduleBootstrap();
						unmanagedParamKeys.set(table, paramKey);
					}
					unmanagedRefCounts.set(table, count + 1);
				}

				cb(client.getRows(table, { includeDeleted: options?.includeDeleted }) as T[]);

				const unsub = client.subscribeTable(table, () => {
					cb(client.getRows(table, { includeDeleted: options?.includeDeleted }) as T[]);
				});

				return () => {
					unsub();
					// Auto-unsync unmanaged tables when last subscriber leaves
					if (!isManaged) {
						const count = (unmanagedRefCounts.get(table) ?? 1) - 1;
						if (count <= 0) {
							unmanagedRefCounts.delete(table);
							unmanagedParamKeys.delete(table);
							client.unsync(table);
						} else {
							unmanagedRefCounts.set(table, count);
						}
					}
				};
			},
		};

		const insert = (rowId: string, payload: Partial<T>) => {
			client.insert(table, rowId, payload as unknown as Record<string, unknown>);
			void pushSafely(client);
		};

		const update = (rowId: string, payload: Partial<T>) => {
			client.update(table, rowId, payload as unknown as Record<string, unknown>);
			void pushSafely(client);
		};

		const remove = (rowId: string) => {
			client.delete(table, rowId);
			void pushSafely(client);
		};

		return { rows, insert, update, remove };
	}

	// ── row (single reactive row) ──────────────────────────────────────

	function row<T extends object = Record<string, unknown>>(
		table: string,
		rowId: string,
	): Readable<T | null> {
		return {
			subscribe(cb) {
				cb(client.getRow(table, rowId) as T | null);
				return client.subscribeTable(table, () => {
					cb(client.getRow(table, rowId) as T | null);
				});
			},
		};
	}

	// ── ephemeral ───────────────────────────────────────────────────────

	function ephemeral<T extends object>(cfg: {
		key: string;
		userId: string;
		ttlMs?: number;
	}): {
		events: Readable<Record<string, T>>;
		broadcast: (data: T) => Promise<void>;
		destroy: () => void;
	} {
		let current: Record<string, T> = {};
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		const subscribers = new Set<(value: Record<string, T>) => void>();

		function notifySubscribers() {
			for (const sub of subscribers) {
				sub(current);
			}
		}

		const unsub = client.subscribeEphemeral(cfg.key, (event: EphemeralEvent) => {
			current = { ...current, [event.clientId]: event.data as T };
			notifySubscribers();

			if (cfg.ttlMs) {
				const existing = timers.get(event.clientId);
				if (existing) {
					clearTimeout(existing);
				}

				const timer = setTimeout(() => {
					const next = { ...current };
					delete next[event.clientId];
					current = next;
					timers.delete(event.clientId);
					notifySubscribers();
				}, cfg.ttlMs);

				timers.set(event.clientId, timer);
			}
		});

		const events: Readable<Record<string, T>> = {
			subscribe(cb) {
				subscribers.add(cb);
				cb(current);
				return () => {
					subscribers.delete(cb);
				};
			},
		};

		const broadcast = (data: T): Promise<void> =>
			client.sendEphemeral({
				key: cfg.key,
				userId: cfg.userId,
				data: data as unknown as Record<string, unknown>,
				ttlMs: cfg.ttlMs,
			});

		const destroy = () => {
			unsub();
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
			timers.clear();
			subscribers.clear();
		};

		return { events, broadcast, destroy };
	}

	// ── totalCount ──────────────────────────────────────────────────────

	function totalCount(table: string): Readable<number | null> {
		return {
			subscribe(cb) {
				cb(client.getTotalCount(table));
				return client.subscribeTable(table, () => {
					cb(client.getTotalCount(table));
				});
			},
		};
	}

	// ── loadMore ────────────────────────────────────────────────────────

	function loadMore(table: string, count: number): void {
		client.loadMore(table, count);
	}

	// ── connect lifecycle ───────────────────────────────────────────────

	async function connectLifecycle(): Promise<void> {
		if (config.storage) {
			await client.init();
		}

		await client.connect();

		for (const table of managedTables) {
			await client.sync(table);
		}

		await client.resume();
	}

	async function close(): Promise<void> {
		await client.close();
	}

	return {
		client,
		status,
		pendingCount,
		sync,
		row,
		ephemeral,
		totalCount,
		loadMore,
		connect: connectLifecycle,
		close,
	};
}
