import { useMemo } from "react";
import type { ReactNode } from "react";
import type {
	SyncQueryMap,
	SyncPresenceDef,
	SyncViewDef,
	InferRow,
	InferState,
	InferParams,
	InferWritableRow,
	RequiresParams,
} from "../core/schema.ts";
import {
	useSync as baseUseSync,
	useSyncStatus,
	useRow as baseUseRow,
	usePendingCount,
	useEphemeral,
	useTotalCount as baseUseTotalCount,
	useLoadMore as baseUseLoadMore,
} from "./hooks.ts";
import { SyncProvider } from "./context.tsx";
import type { SyncProviderProps } from "./context.tsx";
import { useSyncClient } from "./context.tsx";
import type { SyncClientState } from "../client/sync-client.ts";

// ── Typed useSync return type (view-aware) ──────────────────────────────

/**
 * useSync return shape. View entries collapse to a read-only `{ rows }`
 * (plus a `loading` flag) so the type system blocks `insert/update/remove`.
 */
type UseSyncResult<TQueries extends SyncQueryMap, K extends keyof TQueries> =
	TQueries[K] extends SyncViewDef
		? { rows: InferRow<TQueries, K>[]; loading: boolean }
		: {
				rows: InferRow<TQueries, K>[];
				insert: (rowId: string, payload: InferWritableRow<TQueries, K>) => void;
				update: (rowId: string, payload: Partial<InferWritableRow<TQueries, K>>) => void;
				remove: (rowId: string) => void;
			};

// ── Presence helpers ────────────────────────────────────────────────────

/** Keys whose value is a `SyncPresenceDef`. */
type PresenceKeys<TQueries extends SyncQueryMap> = {
	[K in keyof TQueries]: TQueries[K] extends SyncPresenceDef ? K : never;
}[keyof TQueries];

/** Derive a stable presence key from name + serialized params. */
export function derivePresenceKey(
	name: string,
	params?: Record<string, unknown> | undefined,
): string {
	if (!params) return `presence:${name}`;
	const sortedKeys = Object.keys(params).sort();
	const stable: Record<string, unknown> = {};
	for (const k of sortedKeys) stable[k] = params[k];
	return `presence:${name}:${JSON.stringify(stable)}`;
}

interface UsePresenceResult<TState extends Record<string, unknown>> {
	peers: Array<{ userId: string; state: TState }>;
	set: (state: TState) => Promise<void>;
}

// ── Factory return type ─────────────────────────────────────────────────

export interface SyncReactHooks<TQueries extends SyncQueryMap> {
	SyncProvider: (props: SyncProviderProps) => ReactNode;
	useSync: <K extends keyof TQueries & string>(
		...args: RequiresParams<TQueries, K> extends true
			? [table: K, options: UseSyncOptions<TQueries, K>]
			: [table: K, options?: UseSyncOptions<TQueries, K>]
	) => UseSyncResult<TQueries, K>;
	useSyncStatus: () => SyncClientState;
	useRow: <K extends keyof TQueries & string>(table: K, rowId: string) => InferRow<TQueries, K> | null;
	usePendingCount: () => number;
	useEphemeral: <T extends object>(config: { key: string; userId: string; ttlMs?: number }) => { events: Record<string, T>; broadcast: (data: T) => Promise<void> };
	usePresence: <K extends PresenceKeys<TQueries> & string>(
		...args: RequiresParams<TQueries, K> extends true
			? [name: K, params: InferParams<TQueries, K>]
			: [name: K]
	) => UsePresenceResult<InferState<TQueries, K> & Record<string, unknown>>;
	useTotalCount: <K extends keyof TQueries & string>(table: K) => number | null;
	useLoadMore: <K extends keyof TQueries & string>(table: K) => (count: number) => void;
}

// ── Options type (params required when query declares them) ─────────────

type UseSyncOptions<TQueries extends SyncQueryMap, K extends keyof TQueries> =
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

// ── Factory ─────────────────────────────────────────────────────────────

export function createSyncReact<TQueries extends SyncQueryMap>(
	queries?: TQueries,
): SyncReactHooks<TQueries> {
	function useSync<K extends keyof TQueries & string>(
		...args: RequiresParams<TQueries, K> extends true
			? [table: K, options: UseSyncOptions<TQueries, K>]
			: [table: K, options?: UseSyncOptions<TQueries, K>]
	): UseSyncResult<TQueries, K> {
		const [table, options] = args;
		const result = baseUseSync(table, options as never);
		// View entries narrow at the type level to `{ rows, loading }`. Strip
		// the mutator handles at runtime so accidental dynamic access matches
		// the type contract instead of silently calling through.
		const def = queries?.[table] as { __view?: true } | undefined;
		if (def?.__view) {
			return { rows: result.rows, loading: false } as never;
		}
		return result as never;
	}

	function useRow<K extends keyof TQueries & string>(
		table: K,
		rowId: string,
	): InferRow<TQueries, K> | null {
		return baseUseRow(table, rowId) as never;
	}

	function useTotalCount<K extends keyof TQueries & string>(table: K): number | null {
		return baseUseTotalCount(table);
	}

	function useLoadMore<K extends keyof TQueries & string>(table: K): (count: number) => void {
		return baseUseLoadMore(table);
	}

	function usePresence<K extends PresenceKeys<TQueries> & string>(
		...args: RequiresParams<TQueries, K> extends true
			? [name: K, params: InferParams<TQueries, K>]
			: [name: K]
	): UsePresenceResult<InferState<TQueries, K> & Record<string, unknown>> {
		const name = args[0] as string;
		const params = args[1] as Record<string, unknown> | undefined;
		// Read schema-declared TTL if available; falls back to no expiry.
		const def = (queries?.[name] ?? {}) as { ttlMs?: number };
		const ttlMs = def.ttlMs;
		const client = useSyncClient();
		// SyncClient doesn't carry a userId today, so we derive a per-session id
		// from the clientId. This matches presence semantics — peers are uniquely
		// keyed per browser/tab session, not per logged-in identity.
		const userId = (client as unknown as { config?: { clientId?: string } }).config?.clientId
			?? "anonymous";
		const key = useMemo(() => derivePresenceKey(name, params), [name, params]);
		const { events, broadcast } = useEphemeral<Record<string, unknown>>({
			key,
			userId,
			ttlMs,
		});
		const peers = useMemo(
			() =>
				Object.entries(events).map(([uid, state]) => ({
					userId: uid,
					state: state as InferState<TQueries, K> & Record<string, unknown>,
				})),
			[events],
		);
		return { peers, set: broadcast } as UsePresenceResult<
			InferState<TQueries, K> & Record<string, unknown>
		>;
	}

	return {
		SyncProvider: SyncProvider,
		useSync: useSync,
		useSyncStatus: useSyncStatus,
		useRow: useRow,
		usePendingCount: usePendingCount,
		useEphemeral: useEphemeral,
		usePresence: usePresence,
		useTotalCount: useTotalCount,
		useLoadMore: useLoadMore,
	};
}
