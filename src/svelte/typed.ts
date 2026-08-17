import type {
	SyncQueryMap,
	InferRow,
	InferParams,
	InferWritableRow,
	RequiresParams,
} from "../core/schema.ts";
import type { SyncClientState } from "../client/sync-client.ts";
import type { SyncClient } from "../client/sync-client.ts";
import type { Readable, SyncStoreConfig } from "./stores.ts";
import { createSyncStore } from "./stores.ts";

// ── Typed sync options (params required when query declares them) ───────

type SyncOptions<TQueries extends SyncQueryMap, K extends keyof TQueries> =
	RequiresParams<TQueries, K> extends true
		? {
				params: InferParams<TQueries, K>;
				includeDeleted?: boolean;
				window?: number;
			}
		: {
				params?: undefined;
				includeDeleted?: boolean;
				window?: number;
			};

// ── Typed sync result ───────────────────────────────────────────────────

interface SyncResult<TQueries extends SyncQueryMap, K extends keyof TQueries> {
	rows: Readable<InferRow<TQueries, K>[]>;
	insert: (rowId: string, payload: InferWritableRow<TQueries, K>) => void;
	update: (rowId: string, payload: Partial<InferWritableRow<TQueries, K>>) => void;
	remove: (rowId: string) => void;
}

// ── Typed store interface ───────────────────────────────────────────────

export interface TypedSyncStore<TQueries extends SyncQueryMap> {
	client: SyncClient;
	status: Readable<SyncClientState>;
	pendingCount: Readable<number>;

	sync<K extends keyof TQueries & string>(
		...args: RequiresParams<TQueries, K> extends true
			? [table: K, options: SyncOptions<TQueries, K>]
			: [table: K, options?: SyncOptions<TQueries, K>]
	): SyncResult<TQueries, K>;

	row<K extends keyof TQueries & string>(
		table: K,
		rowId: string,
	): Readable<InferRow<TQueries, K> | null>;

	ephemeral<T extends object>(config: {
		key: string;
		userId: string;
		ttlMs?: number;
	}): {
		events: Readable<Record<string, T>>;
		broadcast: (data: T) => Promise<void>;
		destroy: () => void;
	};

	totalCount<K extends keyof TQueries & string>(table: K): Readable<number | null>;
	loadMore<K extends keyof TQueries & string>(table: K, count: number): void;

	connect(): Promise<void>;
	close(): Promise<void>;
}

// ── Factory return type ─────────────────────────────────────────────────

export interface SyncSvelteHooks<TQueries extends SyncQueryMap> {
	createStore: (config: SyncStoreConfig) => TypedSyncStore<TQueries>;
}

// ── Factory ─────────────────────────────────────────────────────────────

export function createSyncSvelte<TQueries extends SyncQueryMap>(): SyncSvelteHooks<TQueries> {
	function createStore(config: SyncStoreConfig): TypedSyncStore<TQueries> {
		const store = createSyncStore(config);
		return store as unknown as TypedSyncStore<TQueries>;
	}

	return { createStore };
}
