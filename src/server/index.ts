export { createServer } from "./server.ts";
export type {
	ServerConfig,
	QueryContext,
	QueryOptions,
	QueryCallback,
	AuthCallback,
	RoomCallback,
	SyncServer,
	ResolvedOp,
	MutateResult,
	MutationContext,
	AuthorizeAction,
	SyncEvent,
} from "./types.ts";
export { MutationError } from "../core/types.ts";
export { resolveConflict } from "./conflict.ts";
export type { ConflictInput, ExistingRow, ConflictResult } from "./conflict.ts";
export {
	enforceClockDrift,
	enforceReadonly,
	enforceServerSet,
	enforceBatchSize,
	createRateLimiter,
} from "./enforcement.ts";
export type { EnforcementResult, EnforcementContext, RateLimiter } from "./enforcement.ts";
export { processOp } from "./pipeline.ts";
export type { PipelineContext, PipelineResult } from "./pipeline.ts";
export { SessionManager } from "./session.ts";
export type { ClientSession, QuerySubscription } from "./session.ts";
export { MessageHandler } from "./handler.ts";
export type { HandlerConfig, QueryRegistration, StorageAdapter, OpLogEntry } from "./handler.ts";
export { createSqliteStorage } from "./storage/sqlite.ts";
export type { SqliteStorageConfig } from "./storage/sqlite.ts";
export { createPostgresStorage } from "./storage/postgres.ts";
export type { PostgresClient, PostgresStorageConfig } from "./storage/postgres.ts";
export { ResultCache } from "./result-cache.ts";
export type { DiffResult } from "./result-cache.ts";
export { BroadcastEngine, stableStringify } from "./broadcast-engine.ts";
export type { BroadcastEngineDeps } from "./broadcast-engine.ts";
export { OpProcessor } from "./op-processor.ts";
export type { BatchContext, OpProcessorDeps, OpResult } from "./op-processor.ts";
export { ServerClock, SERVER_HLC_META_KEY } from "./server-clock.ts";
export { resolveRoomKey } from "./rooms.ts";
export type { RoomResolution } from "./rooms.ts";
export { createSyncServer } from "./typed-server.ts";
export type {
	TypedServerConfig,
	TypedSyncServer,
	ImplementOptions,
	RestConfig,
} from "./typed-server.ts";
export { defineTable } from "./factory.ts";
export type {
	DefineTableOpts,
	ScopeFilter,
	TableAdapter,
} from "./factory.ts";
// Re-export drizzle-specific helpers for back-compat. Importing these
// transitively loads `drizzle-orm`; non-drizzle apps should import from
// `./factory.ts` (or `reflectdb/server`) and use `defineTable` only.
export { drizzleTable, drizzleTxAtomic } from "./drizzle.ts";
export type { DrizzleTableOpts } from "./drizzle.ts";
export type { TxAtomicAdapter } from "./tx-atomic.ts";
export type { TxFn, TxOptions, TxProxy } from "./types.ts";
