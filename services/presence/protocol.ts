/**
 * Wire protocol for the standalone presence service.
 *
 * Deliberately smaller than the reflectdb sync protocol: no op log, no queries,
 * no bootstrap. A client authenticates and joins one room in a single frame,
 * then exchanges room-scoped state that never persists. Usable on its own by
 * apps that do not use reflectdb sync at all.
 */

export const PRESENCE_PROTOCOL_VERSION = 1;

// ── Client → Server ─────────────────────────────────────────────────────────

/** Authenticate and join a room. Must be the first frame on a connection. */
export interface HelloFrame {
	type: "hello";
	protocolVersion: number;
	apiKey: string;
	room: string;
	/**
	 * Display identity carried on every event this connection publishes.
	 * Not trusted for authorization — it is whatever the app wants peers to see.
	 */
	identity?: Record<string, unknown>;
}

/** Publish or update this connection's state on one channel. */
export interface PublishFrame {
	type: "publish";
	/** Channel within the room — "cursor", "typing", "selection", … */
	channel: string;
	data: Record<string, unknown>;
	/** Server clamps this; omit to use the project default. */
	ttlMs?: number;
}

/** Drop this connection's state on one channel without disconnecting. */
export interface ClearFrame {
	type: "clear";
	channel: string;
}

export interface PingFrame {
	type: "ping";
}

export type ClientFrame = HelloFrame | PublishFrame | ClearFrame | PingFrame;

// ── Server → Client ─────────────────────────────────────────────────────────

export interface WelcomeFrame {
	type: "welcome";
	protocolVersion: number;
	/** Server-assigned. Peer identity is the connection, not the account. */
	clientId: string;
	room: string;
}

export interface PeerState {
	clientId: string;
	channel: string;
	data: Record<string, unknown>;
	identity?: Record<string, unknown>;
}

/**
 * Everyone already in the room, sent immediately after `welcome`.
 *
 * Without this a joiner sees an empty room until each peer happens to move
 * again — the single most common way presence implementations look broken.
 */
export interface SnapshotFrame {
	type: "snapshot";
	peers: PeerState[];
}

export interface PresenceFrame extends PeerState {
	type: "presence";
}

/** A peer disconnected or cleared a channel. Sent so cursors vanish at once. */
export interface LeaveFrame {
	type: "leave";
	clientId: string;
	/** Absent when the peer left the room entirely. */
	channel?: string;
}

export type ErrorCode =
	| "bad_frame"
	| "unauthorized"
	| "protocol_version"
	| "room_full"
	| "project_connection_limit"
	| "rate_limited"
	| "internal";

export interface ErrorFrame {
	type: "error";
	code: ErrorCode;
	message: string;
	/** Whether the server is closing the connection after this frame. */
	fatal: boolean;
}

export interface PongFrame {
	type: "pong";
}

export type ServerFrame =
	| WelcomeFrame
	| SnapshotFrame
	| PresenceFrame
	| LeaveFrame
	| ErrorFrame
	| PongFrame;

// ── Validation ──────────────────────────────────────────────────────────────

/** Longest room/channel name accepted. Keeps Redis key sizes bounded. */
export const MAX_NAME_LENGTH = 128;
/** Largest `data` payload accepted, in bytes of JSON. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

/**
 * Parse one inbound frame, or explain why it is unusable.
 *
 * Everything here arrives from a browser, so shape is never assumed: a frame
 * that fails validation is answered with an error rather than crashing the
 * connection handler.
 */
export function parseClientFrame(raw: string): { ok: true; frame: ClientFrame } | {
	ok: false;
	reason: string;
} {
	if (raw.length > MAX_PAYLOAD_BYTES) {
		return { ok: false, reason: `frame exceeds ${MAX_PAYLOAD_BYTES} bytes` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "not valid JSON" };
	}

	if (!isPlainObject(parsed) || typeof parsed.type !== "string") {
		return { ok: false, reason: "missing frame type" };
	}

	switch (parsed.type) {
		case "hello": {
			if (typeof parsed.apiKey !== "string" || parsed.apiKey.length === 0) {
				return { ok: false, reason: "hello requires apiKey" };
			}
			if (!isValidName(parsed.room)) {
				return { ok: false, reason: `hello requires room (1-${MAX_NAME_LENGTH} chars)` };
			}
			if (parsed.identity !== undefined && !isPlainObject(parsed.identity)) {
				return { ok: false, reason: "identity must be an object" };
			}
			if (typeof parsed.protocolVersion !== "number") {
				return { ok: false, reason: "hello requires protocolVersion" };
			}
			return { ok: true, frame: parsed as unknown as HelloFrame };
		}
		case "publish": {
			if (!isValidName(parsed.channel)) {
				return { ok: false, reason: `publish requires channel (1-${MAX_NAME_LENGTH} chars)` };
			}
			if (!isPlainObject(parsed.data)) {
				return { ok: false, reason: "publish requires a data object" };
			}
			if (parsed.ttlMs !== undefined && typeof parsed.ttlMs !== "number") {
				return { ok: false, reason: "ttlMs must be a number" };
			}
			return { ok: true, frame: parsed as unknown as PublishFrame };
		}
		case "clear": {
			if (!isValidName(parsed.channel)) {
				return { ok: false, reason: "clear requires channel" };
			}
			return { ok: true, frame: parsed as unknown as ClearFrame };
		}
		case "ping":
			return { ok: true, frame: { type: "ping" } };
		default:
			return { ok: false, reason: `unknown frame type "${parsed.type}"` };
	}
}
