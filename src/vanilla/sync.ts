import { pushSafely, SyncClient } from "../client/sync-client.ts";
import type { SyncClientState } from "../client/sync-client.ts";
import type { ClientStorageAdapter } from "../client/storage/types.ts";
import type { ClientTransport, ClientMessage, ServerMessage, EphemeralEvent } from "../core/types.ts";

// ── Browser WebSocket Transport ────────────────────────────────────────

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
			handler?.(JSON.parse(event.data as string));
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

// ── Config ─────────────────────────────────────────────────────────────

export interface VanillaSyncConfig {
	url: string;
	token: string;
	tables?: string[];
	clientId?: string;
	storage?: ClientStorageAdapter;
	onReauth?: () => Promise<string>;
	onError?: (error: { opId?: string; reason: string }) => void;
}

// ── Table Binding ──────────────────────────────────────────────────────

export interface TableBinding<T = Record<string, unknown>> {
	getRows(options?: { includeDeleted?: boolean }): T[];
	insert(rowId: string, payload: Partial<T>): void;
	update(rowId: string, payload: Partial<T>): void;
	remove(rowId: string): void;
	onChange(cb: () => void): () => void;
	destroy(): void;
}

// ── Ephemeral Binding ──────────────────────────────────────────────────

export interface EphemeralBinding<T = Record<string, unknown>> {
	getEvents(): Record<string, T>;
	broadcast(data: T): Promise<void>;
	onChange(cb: (events: Record<string, T>) => void): () => void;
	destroy(): void;
}

// ── VanillaSync ────────────────────────────────────────────────────────

export interface VanillaSync {
	client: SyncClient;

	// Lifecycle
	connect(): Promise<void>;
	close(): Promise<void>;

	// State
	getState(): SyncClientState;
	onStateChange(cb: (state: SyncClientState) => void): () => void;

	// Pending
	getPendingCount(): number;
	onPendingChange(cb: (count: number) => void): () => void;

	// Per-table binding
	sync<T extends object = Record<string, unknown>>(
		table: string,
		options?: { params?: Record<string, unknown>; includeDeleted?: boolean; window?: number },
	): TableBinding<T>;

	// Single row
	getRow<T extends object = Record<string, unknown>>(
		table: string,
		rowId: string,
	): T | null;
	onRowChange<T extends object = Record<string, unknown>>(
		table: string,
		rowId: string,
		cb: (row: T | null) => void,
	): () => void;

	// Ephemeral
	ephemeral<T extends object>(config: {
		key: string;
		userId: string;
		ttlMs?: number;
	}): EphemeralBinding<T>;

	// Windowed queries
	getTotalCount(table: string): number | null;
	onTotalCountChange(table: string, cb: (count: number | null) => void): () => void;
	loadMore(table: string, count: number): void;
}

// ── Factory ────────────────────────────────────────────────────────────

export function createSync(config: VanillaSyncConfig): VanillaSync {
	const clientId = config.clientId ?? `browser-${crypto.randomUUID().slice(0, 8)}`;
	const transport = createBrowserWsTransport(config.url);
	const managedTables = new Set(config.tables ?? []);
	// Per-table ref-count + current paramKey so repeated sync() calls with
	// the same params don't re-declare on the server, and a param change
	// cleanly unsyncs the old subscription.
	const unmanagedRefCounts = new Map<string, number>();
	const unmanagedParamKeys = new Map<string, string>();
	function stableKey(obj: Record<string, unknown> | undefined): string {
		if (!obj) return "";
		const keys = Object.keys(obj).sort();
		return keys.map((k) => `${k}:${JSON.stringify(obj[k])}`).join("|");
	}

	const client = new SyncClient({
		clientId,
		transport,
		token: config.token,
		storage: config.storage,
		onReauth: () => config.onReauth?.() ?? Promise.reject(new Error("No onReauth handler")),
		onError: (err) => config.onError?.(err),
	});

	async function connect(): Promise<void> {
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

	function getState(): SyncClientState {
		return client.getState();
	}

	function onStateChange(cb: (state: SyncClientState) => void): () => void {
		let lastState = client.getState();
		return client.subscribe(() => {
			const current = client.getState();
			if (current !== lastState) {
				lastState = current;
				cb(current);
			}
		});
	}

	function getPendingCount(): number {
		return client.getPendingCount();
	}

	function onPendingChange(cb: (count: number) => void): () => void {
		let lastCount = client.getPendingCount();
		return client.subscribe(() => {
			const current = client.getPendingCount();
			if (current !== lastCount) {
				lastCount = current;
				cb(current);
			}
		});
	}

	function sync<T extends object = Record<string, unknown>>(
		table: string,
		options?: { params?: Record<string, unknown>; includeDeleted?: boolean; window?: number },
	): TableBinding<T> {
		const isManaged = managedTables.has(table);
		const paramKey = stableKey(options?.params);

		if (!isManaged) {
			const currentParamKey = unmanagedParamKeys.get(table);
			const count = unmanagedRefCounts.get(table) ?? 0;
			if (count === 0 || currentParamKey !== paramKey) {
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

		return {
			getRows(getOptions?: { includeDeleted?: boolean }): T[] {
				return client.getRows(table, {
					includeDeleted: getOptions?.includeDeleted ?? options?.includeDeleted,
				}) as T[];
			},
			insert(rowId: string, payload: Partial<T>) {
				client.insert(table, rowId, payload as unknown as Record<string, unknown>);
				void pushSafely(client);
			},
			update(rowId: string, payload: Partial<T>) {
				client.update(table, rowId, payload as unknown as Record<string, unknown>);
				void pushSafely(client);
			},
			remove(rowId: string) {
				client.delete(table, rowId);
				void pushSafely(client);
			},
			onChange(cb: () => void): () => void {
				return client.subscribeTable(table, cb);
			},
			destroy() {
				if (isManaged) return;
				const count = (unmanagedRefCounts.get(table) ?? 1) - 1;
				if (count <= 0) {
					unmanagedRefCounts.delete(table);
					unmanagedParamKeys.delete(table);
					client.unsync(table);
				} else {
					unmanagedRefCounts.set(table, count);
				}
			},
		};
	}

	function getRow<T extends object = Record<string, unknown>>(
		table: string,
		rowId: string,
	): T | null {
		return client.getRow(table, rowId) as T | null;
	}

	function onRowChange<T extends object = Record<string, unknown>>(
		table: string,
		rowId: string,
		cb: (row: T | null) => void,
	): () => void {
		return client.subscribeTable(table, () => {
			cb(client.getRow(table, rowId) as T | null);
		});
	}

	function ephemeral<T extends object>(ephConfig: {
		key: string
		userId: string
		ttlMs?: number
	}): EphemeralBinding<T> {
		let events: Record<string, T> = {};
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		const changeListeners = new Set<(events: Record<string, T>) => void>();

		function notifyChange(): void {
			for (const listener of changeListeners) {
				listener(events);
			}
		}

		const unsub = client.subscribeEphemeral(ephConfig.key, (event: EphemeralEvent) => {
			events = { ...events, [event.clientId]: event.data as T };

			if (ephConfig.ttlMs) {
				const existing = timers.get(event.clientId);
				if (existing) {
					clearTimeout(existing);
				}

				const timer = setTimeout(() => {
					const next = { ...events };
					delete next[event.clientId];
					events = next;
					timers.delete(event.clientId);
					notifyChange();
				}, ephConfig.ttlMs);

				timers.set(event.clientId, timer);
			}

			notifyChange();
		});

		return {
			getEvents(): Record<string, T> {
				return events;
			},
			broadcast(data: T): Promise<void> {
				return client.sendEphemeral({
					key: ephConfig.key,
					userId: ephConfig.userId,
					data: data as unknown as Record<string, unknown>,
					ttlMs: ephConfig.ttlMs,
				});
			},
			onChange(cb: (evts: Record<string, T>) => void): () => void {
				changeListeners.add(cb);
				return () => {
					changeListeners.delete(cb);
				};
			},
			destroy() {
				unsub();
				for (const timer of timers.values()) {
					clearTimeout(timer);
				}
				timers.clear();
				changeListeners.clear();
			},
		};
	}

	function getTotalCount(table: string): number | null {
		return client.getTotalCount(table);
	}

	function onTotalCountChange(table: string, cb: (count: number | null) => void): () => void {
		let lastCount = client.getTotalCount(table);
		return client.subscribeTable(table, () => {
			const current = client.getTotalCount(table);
			if (current !== lastCount) {
				lastCount = current;
				cb(current);
			}
		});
	}

	function loadMore(table: string, count: number): void {
		client.loadMore(table, count);
	}

	return {
		client,
		connect,
		close,
		getState,
		onStateChange,
		getPendingCount,
		onPendingChange,
		sync,
		getRow,
		onRowChange,
		ephemeral,
		getTotalCount,
		onTotalCountChange,
		loadMore,
	};
}
