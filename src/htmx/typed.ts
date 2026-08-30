import type { InferRow, InferWritableRow, SyncQueryMap } from "../core/schema.ts";
import type { SyncClientState } from "../client/sync-client.ts";
import type { VanillaSync } from "../vanilla/sync.ts";
import { createHtmxSync } from "./sync.ts";
import type { HtmxSyncConfig, ReflectViewInput } from "./sync.ts";

// ── Typed views ────────────────────────────────────────────────────────

export type TypedReflectView<TQueries extends SyncQueryMap, K extends keyof TQueries> = (
	input: ReflectViewInput<InferRow<TQueries, K>>,
) => string;

export type TypedReflectParse<TQueries extends SyncQueryMap, K extends keyof TQueries> = (
	payload: Record<string, unknown>,
) => Partial<InferWritableRow<TQueries, K>>;

// ── Typed sync ─────────────────────────────────────────────────────────

export interface TypedHtmxSync<TQueries extends SyncQueryMap> {
	sync: VanillaSync;

	view<K extends keyof TQueries & string>(
		table: K,
		view: TypedReflectView<TQueries, K>,
	): TypedHtmxSync<TQueries>;
	parse<K extends keyof TQueries & string>(
		table: K,
		parse: TypedReflectParse<TQueries, K>,
	): TypedHtmxSync<TQueries>;

	install(): TypedHtmxSync<TQueries>;
	uninstall(): void;
	refresh<K extends keyof TQueries & string>(table?: K): void;

	connect(): Promise<void>;
	close(): Promise<void>;
	getState(): SyncClientState;
	onStateChange(cb: (state: SyncClientState) => void): () => void;
	getPendingCount(): number;
	onPendingChange(cb: (count: number) => void): () => void;
}

export interface SyncHtmxHooks<TQueries extends SyncQueryMap> {
	createHtmxSync: (config: HtmxSyncConfig) => TypedHtmxSync<TQueries>;
}

// ── Factory ────────────────────────────────────────────────────────────

export function createSyncHtmx<TQueries extends SyncQueryMap>(): SyncHtmxHooks<TQueries> {
	return {
		createHtmxSync(config: HtmxSyncConfig): TypedHtmxSync<TQueries> {
			return createHtmxSync(config) as unknown as TypedHtmxSync<TQueries>;
		},
	};
}
