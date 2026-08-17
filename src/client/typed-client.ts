import type { ClientOp, ClientTransport, EphemeralEvent } from "../core/types.ts";
import type {
	SyncQueryMap,
	InferRow,
	InferParams,
	InferWritableRow,
	RequiresParams,
} from "../core/schema.ts";
import { SyncClient } from "./sync-client.ts";
import type { SyncClientState, SyncOptions } from "./sync-client.ts";
import type { ClientStorageAdapter } from "./storage/types.ts";

// ── Config ──────────────────────────────────────────────────────────────

export interface TypedSyncClientConfig<TQueries extends SyncQueryMap> {
	queries: TQueries;
	/** Auto-sync all param-less queries on connect */
	autoSync?: boolean;
	clientId: string;
	transport: ClientTransport;
	token: string;
	storage?: ClientStorageAdapter;
	onSync?: (table: string) => void;
	onError?: (error: { opId?: string; reason: string }) => void;
	onReauth?: () => Promise<string>;
}

// ── Typed client interface ──────────────────────────────────────────────

export interface TypedSyncClient<TQueries extends SyncQueryMap> {
	// ── Lifecycle ───────────────────────────────────────────────────────
	init(): Promise<void>;
	connect(): Promise<void>;
	bootstrap(): Promise<void>;
	scheduleBootstrap(): void;
	resume(): Promise<void>;
	push(): Promise<void>;
	close(): Promise<void>;

	// ── Sync (params required when query declares them) ─────────────────
	sync<K extends keyof TQueries & string>(
		...args: RequiresParams<TQueries, K> extends true
			? [name: K, params: InferParams<TQueries, K>, options?: SyncOptions]
			: [name: K, params?: undefined, options?: SyncOptions]
	): Promise<void>;

	unsync<K extends keyof TQueries & string>(name: K): Promise<void>;

	// ── Mutations (payload excludes readonly + serverSet + id) ───────────
	insert<K extends keyof TQueries & string>(
		name: K,
		rowId: string,
		payload: InferWritableRow<TQueries, K>,
	): ClientOp;

	update<K extends keyof TQueries & string>(
		name: K,
		rowId: string,
		payload: Partial<InferWritableRow<TQueries, K>>,
	): ClientOp;

	delete<K extends keyof TQueries & string>(name: K, rowId: string): ClientOp;

	batch(ops: ClientOp[]): ClientOp[];

	// ── Reads (full row type from drizzle table) ────────────────────────
	getRows<K extends keyof TQueries & string>(
		name: K,
		options?: { includeDeleted?: boolean },
	): InferRow<TQueries, K>[];

	getRow<K extends keyof TQueries & string>(name: K, rowId: string): InferRow<TQueries, K> | null;

	// ── Observation ─────────────────────────────────────────────────────
	subscribe(listener: () => void): () => void;
	subscribeTable<K extends keyof TQueries & string>(name: K, listener: () => void): () => void;
	getVersion(): number;
	getTableVersion<K extends keyof TQueries & string>(name: K): number;
	getState(): SyncClientState;
	getPendingCount(): number;

	// ── Windowed sync ───────────────────────────────────────────────────
	loadMore<K extends keyof TQueries & string>(name: K, count: number): void;
	getTotalCount<K extends keyof TQueries & string>(name: K): number | null;

	// ── Ephemeral ───────────────────────────────────────────────────────
	sendEphemeral(config: {
		key: string;
		userId: string;
		data: Record<string, unknown>;
		ttlMs?: number;
	}): Promise<void>;
	subscribeEphemeral(key: string, listener: (event: EphemeralEvent) => void): () => void;
}

// ── Factory ─────────────────────────────────────────────────────────────

export function createSyncClient<TQueries extends SyncQueryMap>(
	config: TypedSyncClientConfig<TQueries>,
): TypedSyncClient<TQueries> {
	const { queries, autoSync, ...clientConfig } = config;
	const client = new SyncClient(clientConfig);

	if (autoSync) {
		const origConnect = client.connect.bind(client);
		client.connect = async () => {
			await origConnect();
			await Promise.all(
				Object.keys(queries)
					.filter((name) => !("params" in queries[name]!))
					.map((name) => client.sync(name)),
			);
		};
	}

	// Double-cast is intentional: InferRow narrows the generic `Record<string, unknown>`
	// return of SyncClient.getRows to per-query row types. A direct cast is rejected
	// because the unparameterized shape doesn't overlap with the parameterized one.
	// TODO: thread TQueries through SyncClient so this layer is a straight extension.
	return client as unknown as TypedSyncClient<TQueries>;
}
