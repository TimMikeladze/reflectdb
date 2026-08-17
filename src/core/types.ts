// ── Op Types ─────────────────────────────────────────────────────────────────

export type OpType = "insert" | "update" | "delete";

export type OpStatus = "pending" | "synced" | "rejected";

export interface SyncOp {
	id: string;
	nodeId: string;
	userId: string;
	hlc: string;
	op: OpType;
	tableName: string;
	rowId: string;
	payload: Record<string, unknown> | null;
	status: OpStatus;
	rejectedReason: ErrorReason | null;
	batchId: string | null;
	batchSize: number | null;
	batchSeq: number | null;
}

// ── Conflict Resolution ──────────────────────────────────────────────────────

/**
 * Server-side conflict policy for concurrent writes to the same row.
 *
 * Scope note for `"merge"`: the server resolves per column using the **client
 * op HLCs** recorded in reflectdb's mirror, so two clients editing different
 * fields both land. The per-column clocks the client sees on a broadcast are a
 * different domain — a diff-driven broadcast can't attribute a column to the
 * op that produced it, so every column changed in one broadcast carries that
 * broadcast's HLC. Client-side merge therefore orders *broadcasts* against each
 * other and against local optimistic state; it does not reconstruct per-column
 * causality between clients. Column-level convergence is a server guarantee.
 */
export type ConflictPolicy = "lww" | "merge" | "server" | CustomConflictPolicy;

export interface CustomConflictPolicy {
	policy: "custom";
	resolve: ConflictResolver;
}

export interface ConflictResolver {
	(
		incoming: { op: OpType; payload: Record<string, unknown> | null; hlc: string },
		existing: {
			row: Record<string, unknown>;
			colClocks: Record<string, string>;
		},
		meta: { table: string; rowId: string; userId: string },
	): { row: Record<string, unknown> };
}

// ── Error Taxonomy ───────────────────────────────────────────────────────────

export type ErrorReason =
	| "outside_shape"
	| "readonly_query"
	| "rate_limited"
	/** Eager broadcast buffer is at capacity — retry after the next flush. */
	| "buffer_full"
	| "server_conflict"
	| "custom_conflict"
	/** Merge policy: client's columns all lost vs existing per-column HLCs.
	 *  No divergence — server state already reflects equal-or-newer values.
	 *  Clients should treat this as a successful no-op and not retry. */
	| "merge_stale"
	| "clock_drift"
	| "replay"
	| "batch_too_large"
	| "schema_outdated"
	| "auth_revoked"
	| "compacted"
	| "mutation_rejected"
	| "server_error"
	| "unknown_query";

export interface SyncError {
	table: string;
	op: SyncOp;
	reason: ErrorReason;
	serverRow: Record<string, unknown> | null;
}

// ── Protocol Messages ────────────────────────────────────────────────────────

// Client → Server

export interface HelloMessage {
	type: "hello";
	/** Highest protocol version the client prefers. Retained for back-compat. */
	protocolVersion: number;
	/** All versions the client can speak. Omit for legacy single-version clients. */
	supportedVersions?: readonly number[];
	clientId: string;
	token: string;
}

export interface BootstrapMessage {
	type: "bootstrap";
	syncParams?: Record<string, Record<string, unknown>>;
}

export interface ResumeMessage {
	type: "resume";
	since: string;
}

export interface OpsMessage {
	type: "ops";
	ops: ClientOp[];
	token: string;
}

export interface ClientOp {
	id: string;
	table: string;
	op: OpType;
	rowId: string;
	payload: Record<string, unknown> | null;
	hlc: string;
	batchId?: string;
	batchSize?: number;
	batchSeq?: number;
}

export interface SyncDeclareMessage {
	type: "sync_declare";
	table: string;
	params?: Record<string, unknown>;
	window?: number;
}

export interface LoadMoreMessage {
	type: "load_more";
	table: string;
	count: number;
}

export interface UnsyncMessage {
	type: "unsync";
	table: string;
}

export interface AuthMessage {
	type: "auth";
	token: string;
}

export interface EphemeralMessage {
	type: "ephemeral";
	key: string;
	userId: string;
	data: Record<string, unknown>;
	ttlMs?: number;
}

// Server → Client

export interface HelloAckMessage {
	type: "hello_ack";
	protocolVersion: number;
	serverId: string;
}

export interface HelloRejectMessage {
	type: "hello_reject";
	reason: string;
	supported: number[];
}

export interface SnapshotMessage {
	type: "snapshot";
	table: string;
	rows: Record<string, unknown>[];
	colClocks: Record<string, Record<string, string>>;
	append?: boolean;
	totalCount?: number;
	/**
	 * Primary key column name for this table. Self-contained per message so the
	 * client doesn't depend on `bootstrap_complete.tableMeta` arriving first.
	 * When omitted (older servers), the client falls back to tableMeta, then "id".
	 */
	pk?: string;
}

export interface BootstrapCompleteMessage {
	type: "bootstrap_complete";
	serverHlc: string;
	tableMeta: Record<string, TableMeta>;
}

export interface TableMeta {
	serverSet: string[];
	readonly: string[];
	broadcast: "consistent" | "eager" | "eager-durable";
	/** Primary key column name. Defaults to "id" when omitted (older servers). */
	pk?: string;
}

export interface DeltaMessage {
	type: "delta";
	table: string;
	op: OpType;
	rowId: string;
	payload: Record<string, unknown> | null;
	hlc: string;
	colClocks?: Record<string, string>;
}

export interface AckMessage {
	type: "ack";
	opIds: string[];
}

export interface RejectMessage {
	type: "reject";
	opId?: string;
	batchId?: string;
	reason: ErrorReason;
	serverRow?: Record<string, unknown>;
}

export interface ResumeCompleteMessage {
	type: "resume_complete";
	serverHlc: string;
}

export interface ResumeRejectedMessage {
	type: "resume_rejected";
	reason: string;
	serverHlc: string;
}

export interface ShapeChangedMessage {
	type: "shape_changed";
	table: string;
	reason: "auth_changed" | "params_changed" | "server_policy";
}

export interface DisconnectMessage {
	type: "disconnect";
	reason: string;
}

export interface ReauthMessage {
	type: "reauth";
}

export interface CountChangedMessage {
	type: "count_changed";
	table: string;
	totalCount: number;
}

export interface EphemeralEvent {
	type: "ephemeral";
	key: string;
	clientId: string;
	userId: string;
	data: Record<string, unknown>;
	ttlMs?: number;
}

// Union of all messages

export type ClientMessage =
	| HelloMessage
	| BootstrapMessage
	| ResumeMessage
	| OpsMessage
	| SyncDeclareMessage
	| LoadMoreMessage
	| UnsyncMessage
	| AuthMessage
	| EphemeralMessage;

export type ServerMessage =
	| HelloAckMessage
	| HelloRejectMessage
	| SnapshotMessage
	| BootstrapCompleteMessage
	| DeltaMessage
	| AckMessage
	| RejectMessage
	| ResumeCompleteMessage
	| ResumeRejectedMessage
	| ShapeChangedMessage
	| DisconnectMessage
	| ReauthMessage
	| EphemeralEvent
	| CountChangedMessage;

export type SyncMessage = ClientMessage | ServerMessage;

// ── Transport Interfaces ─────────────────────────────────────────────────────

/**
 * Thrown/rejected by a `ServerTransport.send` that could not hand the frame to
 * the peer (socket gone, not OPEN, queue overflow, backpressure limit).
 *
 * The broadcast engine treats a resolved `send` as "this delta reached the
 * client" and only then commits the per-client result cache. A transport that
 * swallows failures therefore makes the server believe a client holds rows it
 * never received — divergence that persists until reconnect. Report failures.
 */
export class TransportSendError extends Error {
	constructor(
		public clientId: string,
		message: string,
		public override cause?: unknown,
	) {
		super(message);
		this.name = "TransportSendError";
	}
}

export interface ServerTransport {
	/**
	 * Deliver a message to one client.
	 *
	 * MUST reject (ideally with `TransportSendError`) when the frame could not
	 * be handed to the peer — unknown/closed socket, full outbound queue, or a
	 * throw from the underlying socket. Resolving on a dropped frame makes the
	 * broadcast engine commit result-cache state the client never received.
	 */
	send(clientId: string, message: ServerMessage): Promise<void>;
	broadcast(roomId: string, message: ServerMessage, exclude?: string): Promise<void>;
	onMessage(handler: (clientId: string, message: ClientMessage) => void): void;
	onConnect(handler: (clientId: string, req: Request) => void): void;
	onDisconnect(handler: (clientId: string) => void): void;
	close(): Promise<void>;
	/**
	 * Force-disconnect a single client. Optional — if absent, the handler relies
	 * on the client honoring a `disconnect` server-message. Required for any
	 * transport that carries authentication state, since an adversarial client
	 * can otherwise ignore the message and continue using a revoked session.
	 */
	disconnect?(clientId: string): Promise<void> | void;
}

export interface ClientTransport {
	send(message: ClientMessage): Promise<void>;
	subscribe(handler: (message: ServerMessage) => void): void;
	close(): Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION: number = 1;
/** Versions this peer can speak, highest first. Server picks the highest shared version. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];
export const MAX_CLOCK_DRIFT_MS: number = 5 * 60 * 1000;
export const MAX_BATCH_SIZE: number = 100;
export const TOMBSTONE_RETENTION_MS: number = 7 * 24 * 60 * 60 * 1000;
export const SERVER_TOMBSTONE_RETENTION_MS: number = 90 * 24 * 60 * 60 * 1000;

// ── Dialect ──────────────────────────────────────────────────────────────────

export type Dialect = "postgresql" | "mysql" | "sqlite";

// ── Shape Config ─────────────────────────────────────────────────────────────

export interface ShapeConfig {
	filter?: unknown;
	serverSet?: Record<string, unknown>;
	readonly?: string[];
	conflict?: ConflictPolicy;
}

// ── Rate Limit Config ────────────────────────────────────────────────────────

export interface RateLimitConfig {
	opsPerSecond?: number;
	opsPerMinute?: number;
	batchesPerMinute?: number;
	/**
	 * Per-table overrides. Applied in addition to the global limit: a write
	 * must pass both. Tables missing from this map inherit only the global
	 * bucket. Use to tighten write pressure on hot tables (e.g. ephemeral
	 * chat) without punishing cold ones.
	 */
	perTable?: Record<string, { opsPerSecond?: number; opsPerMinute?: number }>;
	/**
	 * Ceiling on ephemeral (presence/cursor) messages per client per second.
	 * Metered separately from writes so presence traffic and the write budget
	 * don't starve each other. Defaults to 60; 0 disables metering entirely
	 * (each ephemeral message fans out to every room subscriber, so an
	 * unmetered channel is an amplification vector).
	 */
	ephemeralPerSecond?: number;
}

// ── Compaction Config ────────────────────────────────────────────────────────

export interface CompactionConfig {
	clientInactivityTimeout: string;
	interval: string;
	minOpAge: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface AuthContext {
	userId: string;
	[key: string]: unknown;
}

// ── Mutation Error ──────────────────────────────────────────────────────────

export class MutationError extends Error {
	constructor(
		public reason: ErrorReason,
		message?: string,
	) {
		super(message ?? reason);
	}
}

const VALID_ERROR_REASONS: ReadonlySet<string> = new Set<ErrorReason>([
	"outside_shape",
	"readonly_query",
	"rate_limited",
	"buffer_full",
	"server_conflict",
	"custom_conflict",
	"merge_stale",
	"clock_drift",
	"replay",
	"batch_too_large",
	"schema_outdated",
	"auth_revoked",
	"compacted",
	"mutation_rejected",
	"server_error",
	"unknown_query",
]);

export function isErrorReason(value: unknown): value is ErrorReason {
	return typeof value === "string" && VALID_ERROR_REASONS.has(value);
}

/** Safely extract an ErrorReason from an unknown thrown value. Falls back to
 *  "server_error" for non-MutationError throws or invalid reason strings. */
export function reasonFromError(err: unknown): ErrorReason {
	if (err instanceof MutationError && isErrorReason(err.reason)) {
		return err.reason;
	}
	return "server_error";
}
