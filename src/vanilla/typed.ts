import type {
	SyncQueryMap,
	InferRow,
	InferParams,
	InferWritableRow,
	RequiresParams,
} from "../core/schema.ts";
import type { SyncClientState } from "../client/sync-client.ts";
import type { SyncClient } from "../client/sync-client.ts";
import { createSync } from "./sync.ts";
import type { VanillaSyncConfig, EphemeralBinding } from "./sync.ts";

// ── Typed table binding ────────────────────────────────────────────────

interface TypedTableBinding<TQueries extends SyncQueryMap, K extends keyof TQueries> {
	getRows(options?: { includeDeleted?: boolean }): InferRow<TQueries, K>[];
	insert(rowId: string, payload: InferWritableRow<TQueries, K>): void;
	update(rowId: string, payload: Partial<InferWritableRow<TQueries, K>>): void;
	remove(rowId: string): void;
	onChange(cb: () => void): () => void;
	destroy(): void;
}

// ── Typed sync options (params required when query declares them) ──────

type TypedSyncOptions<TQueries extends SyncQueryMap, K extends keyof TQueries> =
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

// ── Typed VanillaSync ──────────────────────────────────────────────────

export interface TypedVanillaSync<TQueries extends SyncQueryMap> {
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
	sync<K extends keyof TQueries & string>(
		...args: RequiresParams<TQueries, K> extends true
			? [table: K, options: TypedSyncOptions<TQueries, K>]
			: [table: K, options?: TypedSyncOptions<TQueries, K>]
	): TypedTableBinding<TQueries, K>;

	// Single row
	getRow<K extends keyof TQueries & string>(
		table: K,
		rowId: string,
	): InferRow<TQueries, K> | null;
	onRowChange<K extends keyof TQueries & string>(
		table: K,
		rowId: string,
		cb: (row: InferRow<TQueries, K> | null) => void,
	): () => void;

	// Ephemeral
	ephemeral<T extends object>(config: {
		key: string;
		userId: string;
		ttlMs?: number;
	}): EphemeralBinding<T>;

	// Windowed queries
	getTotalCount<K extends keyof TQueries & string>(table: K): number | null;
	onTotalCountChange<K extends keyof TQueries & string>(
		table: K,
		cb: (count: number | null) => void,
	): () => void;
	loadMore<K extends keyof TQueries & string>(table: K, count: number): void;
}

// ── Factory return type ────────────────────────────────────────────────

export interface SyncVanillaHooks<TQueries extends SyncQueryMap> {
	createSync: (config: VanillaSyncConfig) => TypedVanillaSync<TQueries>;
}

// ── Factory ────────────────────────────────────────────────────────────

export function createSyncVanilla<TQueries extends SyncQueryMap>(): SyncVanillaHooks<TQueries> {
	return {
		createSync(config: VanillaSyncConfig): TypedVanillaSync<TQueries> {
			const base = createSync(config);
			return base as unknown as TypedVanillaSync<TQueries>;
		},
	};
}
