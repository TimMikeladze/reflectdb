/**
 * Wire protocol for the standalone presence service.
 *
 * Deliberately smaller than the reflectdb sync protocol: no op log, no queries,
 * no bootstrap. A client opens one SSE stream for a room and POSTs its own
 * state to that room. Usable on its own by apps that do not use reflectdb sync
 * at all.
 *
 * Version 2 moved off WebSockets. The frames a client *receives* are unchanged
 * in shape — they now arrive as SSE `data:` lines rather than socket messages —
 * but the frames a client used to *send* are gone: `hello` became the stream's
 * query string, and `publish`/`clear` became HTTP POSTs. Nothing about that is
 * a nicety; it is what lets the service run on a platform with no sockets.
 */

export const PRESENCE_PROTOCOL_VERSION = 2;

// ── Client → Server ─────────────────────────────────────────────────────────
//
// There is no client frame type. A client's three verbs are three HTTP calls:
//
//   GET  {base}/stream?apiKey=&room=&clientId=   open the stream (was `hello`)
//   POST {base}/publish                          set state       (was `publish`)
//   POST {base}/leave                            drop state      (was `clear`)
//
// `clientId` is minted by the client and persisted for the tab, because an SSE
// stream is not a session: it ends every minute or so and the client opens
// another. A server-minted id would change on each of those, and every peer
// would watch the same person leave and rejoin all day.

/** Body of `POST /publish`. */
export interface PublishRequest {
	apiKey: string;
	room: string;
	clientId: string;
	/** Channel within the room — "cursor", "typing", "selection", … */
	channel: string;
	data: Record<string, unknown>;
	/**
	 * Display identity shown to peers. Carried per publish rather than per
	 * session: with no socket there is nothing for a session to live in.
	 */
	identity?: Record<string, unknown>;
	/** Server clamps this; omit to use the project default. */
	ttlMs?: number;
}

/** Body of `POST /leave`. Omit `channel` to drop everything the client holds. */
export interface LeaveRequest {
	apiKey: string;
	room: string;
	clientId: string;
	channel?: string;
}

// ── Server → Client ─────────────────────────────────────────────────────────
//
// One SSE stream carries all of these on the default `message` event, each as a
// JSON object with a `type` — rather than named SSE events — so a client needs
// one handler and one parse, and an unknown future frame type is ignorable
// instead of silently unsubscribed.

export interface WelcomeFrame {
	type: "welcome";
	protocolVersion: number;
	/** Echoed back, so a client can confirm the id the server is using. */
	clientId: string;
	room: string;
	/**
	 * How long this stream will stay open. The client uses it to tell an
	 * expected recycle from a real failure and skip the backoff on the former.
	 */
	streamMs: number;
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

/** A peer's state went away — it was cleared, the peer left, or it expired. */
export interface LeaveFrame {
	type: "leave";
	clientId: string;
	/** Absent when the peer left the room entirely. */
	channel?: string;
}

export type ErrorCode =
	| "bad_request"
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
	/** Whether the server is ending the stream after this frame. */
	fatal: boolean;
}

/**
 * This stream reached its time limit and is closing normally.
 *
 * Serverless functions do not run forever, so the stream is recycled on a
 * schedule rather than killed mid-flight. Saying so lets the client reconnect
 * at once instead of treating a healthy close as an outage worth backing off
 * from.
 */
export interface ByeFrame {
	type: "bye";
	reason: "recycle";
}

export type ServerFrame =
	| WelcomeFrame
	| SnapshotFrame
	| PresenceFrame
	| LeaveFrame
	| ErrorFrame
	| ByeFrame;

// ── Validation ──────────────────────────────────────────────────────────────

/** Longest room/channel/client name accepted. Keeps row and index sizes bounded. */
export const MAX_NAME_LENGTH = 128;
/** Largest `data` payload accepted, in bytes of JSON. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Parse a `POST /publish` body, or explain why it is unusable.
 *
 * Everything here arrives from a browser, so shape is never assumed: a body
 * that fails validation is answered with a 400 rather than reaching the store.
 */
export function parsePublishRequest(raw: unknown): Parsed<PublishRequest> {
	if (!isPlainObject(raw)) return { ok: false, reason: "body must be a JSON object" };
	if (typeof raw.apiKey !== "string" || raw.apiKey.length === 0) {
		return { ok: false, reason: "publish requires apiKey" };
	}
	if (!isValidName(raw.room)) {
		return { ok: false, reason: `publish requires room (1-${MAX_NAME_LENGTH} chars)` };
	}
	if (!isValidName(raw.clientId)) {
		return { ok: false, reason: `publish requires clientId (1-${MAX_NAME_LENGTH} chars)` };
	}
	if (!isValidName(raw.channel)) {
		return { ok: false, reason: `publish requires channel (1-${MAX_NAME_LENGTH} chars)` };
	}
	if (!isPlainObject(raw.data)) return { ok: false, reason: "publish requires a data object" };
	if (raw.identity !== undefined && !isPlainObject(raw.identity)) {
		return { ok: false, reason: "identity must be an object" };
	}
	if (raw.ttlMs !== undefined && typeof raw.ttlMs !== "number") {
		return { ok: false, reason: "ttlMs must be a number" };
	}
	return { ok: true, value: raw as unknown as PublishRequest };
}

/** Parse a `POST /leave` body, or explain why it is unusable. */
export function parseLeaveRequest(raw: unknown): Parsed<LeaveRequest> {
	if (!isPlainObject(raw)) return { ok: false, reason: "body must be a JSON object" };
	if (typeof raw.apiKey !== "string" || raw.apiKey.length === 0) {
		return { ok: false, reason: "leave requires apiKey" };
	}
	if (!isValidName(raw.room)) return { ok: false, reason: "leave requires room" };
	if (!isValidName(raw.clientId)) return { ok: false, reason: "leave requires clientId" };
	if (raw.channel !== undefined && !isValidName(raw.channel)) {
		return { ok: false, reason: "channel must be a non-empty name" };
	}
	return { ok: true, value: raw as unknown as LeaveRequest };
}

export interface StreamRequest {
	apiKey: string;
	room: string;
	clientId: string;
}

/** Parse the query string of `GET /stream`. */
export function parseStreamRequest(params: URLSearchParams): Parsed<StreamRequest> {
	const apiKey = params.get("apiKey");
	const room = params.get("room");
	const clientId = params.get("clientId");
	if (!apiKey) return { ok: false, reason: "stream requires apiKey" };
	if (!isValidName(room)) {
		return { ok: false, reason: `stream requires room (1-${MAX_NAME_LENGTH} chars)` };
	}
	if (!isValidName(clientId)) {
		return { ok: false, reason: `stream requires clientId (1-${MAX_NAME_LENGTH} chars)` };
	}
	return { ok: true, value: { apiKey, room, clientId } };
}

/** Reject an oversized payload before it is parsed or stored. */
export function payloadTooLarge(data: unknown): boolean {
	try {
		return JSON.stringify(data).length > MAX_PAYLOAD_BYTES;
	} catch {
		return true;
	}
}

/** Encode one frame as an SSE `data:` line. */
export function encodeFrame(frame: ServerFrame): string {
	return `data: ${JSON.stringify(frame)}\n\n`;
}
