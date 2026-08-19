/**
 * Wire types for the presence service, as the browser sees them.
 *
 * Vendored from `services/presence/protocol.ts`. The landing page is deployed
 * from `landing/` alone, so it cannot import across the repo — this is a copy,
 * trimmed to the frames a client actually receives. Re-copy it when the
 * protocol version changes; `PRESENCE_PROTOCOL_VERSION` is what the server
 * checks, so a stale copy fails loudly at `hello` rather than silently.
 */

export const PRESENCE_PROTOCOL_VERSION = 1;

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

/** Everyone already in the room, sent immediately after `welcome`. */
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
