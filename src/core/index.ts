// HLC
export { createHlc, sendHlc, receiveHlc, packHlc, unpackHlc, compareHlc, type HLC } from "./hlc.ts";

// Types
export type {
	OpType,
	OpStatus,
	SyncOp,
	ConflictPolicy,
	CustomConflictPolicy,
	ConflictResolver,
	ErrorReason,
	SyncError,
	ClientMessage,
	ServerMessage,
	SyncMessage,
	HelloMessage,
	BootstrapMessage,
	ResumeMessage,
	OpsMessage,
	ClientOp,
	SyncDeclareMessage,
	LoadMoreMessage,
	CountChangedMessage,
	UnsyncMessage,
	AuthMessage,
	HelloAckMessage,
	HelloRejectMessage,
	SnapshotMessage,
	BootstrapCompleteMessage,
	TableMeta,
	DeltaMessage,
	AckMessage,
	RejectMessage,
	ResumeCompleteMessage,
	ResumeRejectedMessage,
	ShapeChangedMessage,
	DisconnectMessage,
	ReauthMessage,
	ServerTransport,
	ClientTransport,
	Dialect,
	ShapeConfig,
	RateLimitConfig,
	CompactionConfig,
	AuthContext,
} from "./types.ts";

export {
	PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	MAX_CLOCK_DRIFT_MS,
	MAX_BATCH_SIZE,
	TOMBSTONE_RETENTION_MS,
	SERVER_TOMBSTONE_RETENTION_MS,
	MutationError,
	TransportSendError,
	isErrorReason,
	reasonFromError,
} from "./types.ts";

export type { EphemeralEvent, EphemeralMessage } from "./types.ts";

// Schema
export { defineSyncQueries, t, view, presence } from "./schema.ts";
export type {
	DrizzleTableLike,
	SyncQueryDef,
	SyncViewDef,
	SyncPresenceDef,
	SyncQueryEntry,
	SyncQueryMap,
	InferRow,
	InferState,
	InferParams,
	InferWritableRow,
	RequiresParams,
} from "./schema.ts";
