/**
 * POST /api/sync/messages — one client message, replies returned inline.
 *
 * This is the half of the serverless SSE split that carries writes. The
 * client's event stream is held by a DIFFERENT invocation, so anything the
 * server produces in response to this message — `hello_ack`, the bootstrap
 * snapshot, op acks — can only get back to the client in this response body.
 * `collectReplies` is what gathers them; see `serverless` in
 * src/transport/sse.ts.
 */

import type { ClientMessage } from "../../../../src/core/types.ts";
import { boardIdFrom, closeBoard, createBoard } from "../../lib/board.ts";
import { resetIfDue } from "../../lib/reset.ts";

/** Node runtime rather than edge: the S3 driver signs with WebCrypto and streams responses. */
export const config = { runtime: "nodejs" };

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const clientId = url.searchParams.get("clientId");
	if (!clientId) return json({ error: "clientId is required" }, 400);

	const raw = await request.text();
	// Size-gate before parsing: the transport caps message size too, but that
	// check runs after JSON.parse has already done the expensive part.
	if (raw.length > MAX_BODY_BYTES) return json({ error: "message too large" }, 413);

	let message: ClientMessage;
	try {
		message = JSON.parse(raw) as ClientMessage;
	} catch {
		return json({ error: "invalid JSON" }, 400);
	}

	const boardId = boardIdFrom(url);
	const board = createBoard(boardId);
	try {
		// Before the session is rebuilt, so a visitor whose arrival triggers the
		// reset is never handed the previous window's cards in their bootstrap
		// snapshot and then shown them vanishing a moment later.
		await resetIfDue(board, boardId);
		await restoreSession(board, clientId, message);
		const messages = await board.transport.collectReplies(clientId, message, () =>
			board.handler.whenIdle(clientId),
		);
		// Flush before responding. An ack the client has already acted on must not
		// be sitting in a buffer when this invocation is frozen — the durability
		// the ack promised has to be real by the time it is sent.
		await board.storage.flush();
		return json({ messages }, 200);
	} finally {
		// Releases the flush loop and any timers. The next request builds a fresh
		// board; the bucket is the only thing that persists.
		await closeBoard(board);
	}
}

/**
 * Rebuilds the client's session before handling its message.
 *
 * A long-lived server remembers that this client said `hello` and subscribed to
 * `cards`. This invocation remembers nothing — it was created a millisecond ago
 * and will be discarded when the response is sent — so without this every
 * message after the handshake is rejected as unauthenticated, and `bootstrap`
 * answers with no snapshot because nothing is subscribed.
 *
 * The session is cheap to rebuild because it is only identity plus a table
 * list; the actual data is in the bucket. Its replies are discarded: the client
 * already has its `hello_ack` from whichever invocation handled the real
 * handshake, and sending a second one would confuse it.
 *
 * A multi-table app would carry the subscription set on the request rather than
 * hard-coding it here.
 */
async function restoreSession(
	board: ReturnType<typeof createBoard>,
	clientId: string,
	message: ClientMessage,
): Promise<void> {
	// A real `hello` establishes the session itself; replaying one first would
	// double the handshake.
	if (message.type === "hello") return;

	const settle = () => board.handler.whenIdle(clientId);
	await board.transport.collectReplies(
		clientId,
		{ type: "hello", clientId, token: "anonymous", protocolVersion: 1 } as ClientMessage,
		settle,
	);
	// Re-declaring a subscription the client already has is idempotent.
	if (message.type !== "sync_declare") {
		await board.transport.collectReplies(
			clientId,
			{ type: "sync_declare", table: "cards" } as ClientMessage,
			settle,
		);
	}
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
	});
}
