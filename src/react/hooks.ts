import {
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { pushSafely } from "../client/sync-client.ts";
import type { SyncClient, SyncClientState } from "../client/sync-client.ts";
import type { EphemeralEvent } from "../core/types.ts";
import { SyncContext } from "./context.tsx";
import { useSyncClient } from "./context.tsx";

/**
 * Subscribe to a table and get reactive rows + mutation functions.
 *
 * If the table is listed in `<SyncProvider tables={[...]}>`
 * the provider manages sync lifecycle. Otherwise the hook handles it.
 *
 * ```tsx
 * function PostList() {
 *   const { rows, insert, update, remove } = useSync("posts");
 *   return rows.map(p => <div key={p.id}>{p.title}</div>);
 * }
 * ```
 */
export function useSync<T extends object = Record<string, unknown>>(
	table: string,
	options?: {
		params?: Record<string, unknown>;
		includeDeleted?: boolean;
		window?: number;
	},
): {
	rows: T[];
	insert: (rowId: string, payload: Partial<T>) => void;
	update: (rowId: string, payload: Partial<T>) => void;
	remove: (rowId: string) => void;
} {
	const ctx = useContext(SyncContext);
	if (!ctx) {
		throw new Error("useSync must be used within a <SyncProvider>");
	}

	const { client, managedTables } = ctx;

	// If the table isn't managed by the provider, manage sync lifecycle here.
	// Ref-counted so multiple useSync hooks for the same table don't undo
	// each other's sync()/unsync() on mount/unmount.
	useEffect(() => {
		if (managedTables.has(table)) return;

		acquireSync(
			client,
			table,
			options?.params,
			options?.window ? { window: options.window } : undefined,
		);
		// Bootstrap to fetch initial data for this subscription.
		// scheduleBootstrap coalesces multiple calls within the same tick,
		// so concurrent useSync hooks produce a single bootstrap request.
		client.scheduleBootstrap();
		return () => {
			releaseSync(client, table);
		};
	}, [client, table, managedTables, stableKey(options?.params), options?.window]);

	const subscribe = useCallback(
		(listener: () => void) => client.subscribeTable(table, listener),
		[client, table],
	);

	const version = useSyncExternalStore(
		subscribe,
		() => client.getTableVersion(table),
		() => client.getTableVersion(table),
	);

	const rows = useMemo(
		() => client.getRows(table, { includeDeleted: options?.includeDeleted }) as T[],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[client, table, version, options?.includeDeleted],
	);

	const insert = useCallback(
		(rowId: string, payload: Partial<T>) => {
			client.insert(table, rowId, payload as unknown as Record<string, unknown>);
			void pushSafely(client);
		},
		[client, table],
	);

	const update = useCallback(
		(rowId: string, payload: Partial<T>) => {
			client.update(table, rowId, payload as unknown as Record<string, unknown>);
			void pushSafely(client);
		},
		[client, table],
	);

	const remove = useCallback(
		(rowId: string) => {
			client.delete(table, rowId);
			void pushSafely(client);
		},
		[client, table],
	);

	return { rows: rows, insert: insert, update: update, remove: remove };
}

/**
 * Get the current sync connection state.
 *
 * ```tsx
 * function StatusBar() {
 *   const status = useSyncStatus();
 *   return <div>{status}</div>;
 * }
 * ```
 */
export function useSyncStatus(): SyncClientState {
	const client = useSyncClient();

	const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);

	// Track state directly. SyncClientState is a string union, so identity
	// is stable and React skips renders when status is unchanged.
	return useSyncExternalStore(
		subscribe,
		() => client.getState(),
		() => client.getState(),
	);
}

/**
 * Get a single row by ID, reactively.
 *
 * ```tsx
 * function PostDetail({ id }: { id: string }) {
 *   const post = useRow("posts", id);
 *   if (!post) return <div>Not found</div>;
 *   return <div>{post.title}</div>;
 * }
 * ```
 */
export function useRow<T extends object = Record<string, unknown>>(
	table: string,
	rowId: string,
): T | null {
	const client = useSyncClient();

	const subscribe = useCallback(
		(listener: () => void) => client.subscribeTable(table, listener),
		[client, table],
	);

	const version = useSyncExternalStore(
		subscribe,
		() => client.getTableVersion(table),
		() => client.getTableVersion(table),
	);

	return useMemo(
		() => client.getRow(table, rowId) as T | null,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[client, table, rowId, version],
	);
}

/**
 * Get the number of pending (unsynced) operations.
 */
export function usePendingCount(): number {
	const client = useSyncClient();

	const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);

	const version = useSyncExternalStore(
		subscribe,
		() => client.getVersion(),
		() => client.getVersion(),
	);

	return useMemo(
		() => client.getPendingCount(),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[client, version],
	);
}

/**
 * Subscribe to ephemeral events (transient, fire-and-forget).
 * Returns current events by userId and a broadcast function.
 *
 * ```tsx
 * function CursorTracker({ userId }: { userId: string }) {
 *   const { events, broadcast } = useEphemeral({
 *     key: "cursor",
 *     userId,
 *     ttlMs: 5000,
 *   });
 *
 *   useEffect(() => {
 *     const interval = setInterval(() => {
 *       broadcast({ x: Math.random() * 100, y: Math.random() * 100 });
 *     }, 100);
 *     return () => clearInterval(interval);
 *   }, [broadcast]);
 *
 *   return (
 *     <div>
 *       {Object.entries(events).map(([uid, data]) => (
 *         <div key={uid}>User {uid}: {JSON.stringify(data)}</div>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useEphemeral<T extends object>(config: {
	key: string;
	userId: string;
	ttlMs?: number;
}): {
	events: Record<string, T>;
	broadcast: (data: T) => Promise<void>;
} {
	const client = useSyncClient();
	const [events, setEvents] = useState<Record<string, T>>({});
	const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

	useEffect(() => {
		const unsub = client.subscribeEphemeral(config.key, (event: EphemeralEvent) => {
			setEvents((prev) => ({ ...prev, [event.userId]: event.data as T }));

			// Schedule stale entry cleanup if TTL is set
			if (config.ttlMs) {
				const existing = timersRef.current.get(event.userId);
				if (existing) {
					clearTimeout(existing);
				}

				const timer = setTimeout(() => {
					setEvents((prev) => {
						const next = { ...prev };
						delete next[event.userId];
						return next;
					});
					timersRef.current.delete(event.userId);
				}, config.ttlMs);

				timersRef.current.set(event.userId, timer);
			}
		});

		return () => {
			unsub();
			for (const timer of timersRef.current.values()) {
				clearTimeout(timer);
			}
			timersRef.current.clear();
		};
	}, [client, config.key, config.ttlMs]);

	const broadcast = useCallback(
		(data: T): Promise<void> =>
			client.sendEphemeral({
				key: config.key,
				userId: config.userId,
				data: data as unknown as Record<string, unknown>,
				ttlMs: config.ttlMs,
			}),
		[client, config.key, config.userId, config.ttlMs],
	);

	return { events, broadcast };
}

/**
 * Get the total server-side count for a windowed query.
 * Returns null if the query isn't windowed or count hasn't been received yet.
 */
export function useTotalCount(table: string): number | null {
	const client = useSyncClient();

	const subscribe = useCallback(
		(listener: () => void) => client.subscribeTable(table, listener),
		[client, table],
	);

	const version = useSyncExternalStore(
		subscribe,
		() => client.getTableVersion(table),
		() => client.getTableVersion(table),
	);

	return useMemo(
		() => client.getTotalCount(table),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[client, table, version],
	);
}

/**
 * Get a loadMore callback for a windowed query.
 */
export function useLoadMore(table: string): (count: number) => void {
	const client = useSyncClient();

	return useCallback(
		(count: number) => {
			client.loadMore(table, count);
		},
		[client, table],
	);
}

function stableKey(params?: Record<string, unknown>): string {
	if (!params) return "";
	return JSON.stringify(params, Object.keys(params).sort());
}

// Per-client ref counts so multiple useSync hooks targeting the same table
// don't undo each other's sync()/unsync(). Last-mounted-with-different-params
// still replaces the active params (matching svelte/vanilla behavior).
const useSyncRefCounts = new WeakMap<SyncClient, Map<string, number>>();
const useSyncParamKeys = new WeakMap<SyncClient, Map<string, string>>();

function acquireSync(
	client: SyncClient,
	table: string,
	params: Record<string, unknown> | undefined,
	options: { window?: number } | undefined,
): void {
	let counts = useSyncRefCounts.get(client);
	if (!counts) {
		counts = new Map();
		useSyncRefCounts.set(client, counts);
	}
	let keys = useSyncParamKeys.get(client);
	if (!keys) {
		keys = new Map();
		useSyncParamKeys.set(client, keys);
	}
	const key = stableKey(params);
	const prev = keys.get(table);
	const cnt = counts.get(table) ?? 0;
	if (cnt === 0 || prev !== key) {
		if (prev !== undefined && prev !== key) client.unsync(table);
		client.sync(table, params, options);
		keys.set(table, key);
	}
	counts.set(table, cnt + 1);
}

function releaseSync(client: SyncClient, table: string): void {
	const counts = useSyncRefCounts.get(client);
	const keys = useSyncParamKeys.get(client);
	if (!counts || !keys) return;
	const cnt = (counts.get(table) ?? 1) - 1;
	if (cnt <= 0) {
		counts.delete(table);
		keys.delete(table);
		client.unsync(table);
	} else {
		counts.set(table, cnt);
	}
}
