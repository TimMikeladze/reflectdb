/**
 * GET /api/sync/events — the held SSE stream, carrying OTHER people's changes.
 *
 * This invocation never handles the client's own messages; those go to
 * `messages.ts` and are answered inline there. What it does is watch the bucket:
 *
 *     refresh()            one manifest GET; false when nothing moved
 *     pollRemoteChanges()  re-run the affected queries, push deltas
 *
 * `refresh()` is the load-bearing call. Under `concurrency: "optimistic"` this
 * instance's in-memory state is NOT authoritative — a teammate's card moved on
 * some other invocation entirely — so without it `pollRemoteChanges` would
 * compare against a view that never changes and stream nothing, forever.
 */

import type { ClientMessage } from "../../../../src/core/types.ts";
import { type Board, boardIdFrom, closeBoard, createBoard } from "../../lib/board.ts";
import { resetIfDue, resetWindow } from "../../lib/reset.ts";

export const config = { runtime: "nodejs", maxDuration: 300 };

/**
 * Replays `hello` + `sync_declare` so this invocation has a subscriber to push to.
 *
 * The replies are discarded: the client already has its `hello_ack` and its
 * snapshot from whichever invocation answered the real handshake, and sending a
 * second set down the stream would have it re-bootstrap over its own state.
 *
 * A multi-table app would carry the subscription set on the request rather than
 * hard-coding it, exactly as `messages.ts` notes.
 */
async function restoreSubscription(board: Board, clientId: string): Promise<void> {
	const settle = () => board.handler.whenIdle(clientId);
	await board.transport.collectReplies(
		clientId,
		{ type: "hello", clientId, token: "anonymous", protocolVersion: 1 } as ClientMessage,
		settle,
	);
	await board.transport.collectReplies(
		clientId,
		{ type: "sync_declare", table: "cards" } as ClientMessage,
		settle,
	);
	// `sync_declare` subscribes but leaves this instance's result cache empty,
	// and the broadcast engine emits a DIFF against that cache. An empty one
	// makes every current row look new and every removed row invisible: the
	// stream would push five inserts for cards the client already has and never
	// mention the card that was deleted. `bootstrap` fills the cache with what
	// the client is actually holding, which is what makes the diff meaningful.
	await board.transport.collectReplies(
		clientId,
		{ type: "bootstrap" } as ClientMessage,
		settle,
	);
}

/**
 * How often to check the manifest. Each tick is one small GET when the board is
 * idle, so this is the knob that trades demo latency against request cost:
 * 250ms is ~4 GETs/second per open tab, and a board with nobody looking at it
 * costs nothing at all.
 */
const POLL_MS = 250;

/** Comfortably inside Vercel's function ceiling, so the stream ends cleanly rather than being cut. */
const MAX_STREAM_MS = 4 * 60 * 1000;

/** Keeps proxies from closing an idle stream, and lets the client notice a dead one. */
const HEARTBEAT_MS = 20_000;

export async function GET(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const clientId = url.searchParams.get("clientId");
	if (!clientId) return new Response("clientId is required", { status: 400 });

	const boardId = boardIdFrom(url);
	const board = createBoard(boardId);
	// Boot before the first poll so the first tick compares against real state
	// rather than reporting the whole board as "changed".
	await board.storage.init();

	// The window this stream has already checked. A tab left open for an hour
	// still sees the board reset on schedule, because the poll loop below
	// re-checks whenever the clock rolls into a new one — and once per window
	// rather than four times a second, which is what this variable is for.
	let checkedWindow = resetWindow();
	await resetIfDue(board, boardId);

	// Rebuild the client's subscription in THIS process, for the same reason
	// `messages.ts` rebuilds its session: the `sync_declare` the client sent went
	// to a different invocation, and the broadcast engine only pushes to
	// subscribers it can see. Without it `pollRemoteChanges` faithfully notices
	// every remote write and then has nobody to send it to, so the stream sits
	// silent and the board is single-player.
	await restoreSubscription(board, clientId);

	// Prime the poll watermark. `pollRemoteChanges` adopts the current op-log
	// head on its first call rather than replaying history — and the loop below
	// only calls it when `refresh()` reports movement, so without this the first
	// call is the one that already carries a remote change, and that change is
	// adopted as the baseline instead of being pushed. One swallowed card is
	// exactly the symptom nobody thinks to look for.
	await board.handler.pollRemoteChanges();

	const encoder = new TextEncoder();
	let poll: ReturnType<typeof setInterval> | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let deadline: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	async function shutdown(): Promise<void> {
		if (closed) return;
		closed = true;
		if (poll) clearInterval(poll);
		if (heartbeat) clearInterval(heartbeat);
		if (deadline) clearTimeout(deadline);
		await closeBoard(board);
	}

	const stream = new ReadableStream({
		start: (controller) => {
			board.transport.handleSubscribe(
				clientId,
				controller,
				request.headers.get("last-event-id") ?? undefined,
			);

			// Overlapping ticks would stack manifest GETs on a slow bucket and
			// re-enter the broadcast engine, so a tick that is still running skips
			// the next one rather than queueing behind it.
			let ticking = false;
			poll = setInterval(() => {
				if (ticking || closed) return;
				ticking = true;
				void (async () => {
					try {
						const window = resetWindow();
						if (window !== checkedWindow) {
							checkedWindow = window;
							await resetIfDue(board, boardId);
						}
						if (await board.storage.refresh()) {
							await board.handler.pollRemoteChanges();
						}
					} catch (error) {
						console.error("[kanban] poll failed:", error);
					} finally {
						ticking = false;
					}
				})();
			}, POLL_MS);

			heartbeat = setInterval(() => {
				if (closed) return;
				try {
					// An SSE comment: ignored by EventSource, but it keeps the
					// connection warm through proxies that drop idle streams.
					controller.enqueue(encoder.encode(": ping\n\n"));
				} catch {
					void shutdown();
				}
			}, HEARTBEAT_MS);

			// End the stream ourselves rather than letting the platform kill it
			// mid-frame. EventSource reconnects on a clean close, and Last-Event-ID
			// replay means the client misses nothing across the seam.
			deadline = setTimeout(() => {
				void shutdown().then(() => {
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				});
			}, MAX_STREAM_MS);
		},
		cancel: () => {
			board.transport.handleDisconnect(clientId);
			void shutdown();
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			// Vercel and most CDNs buffer responses by default, which would hold
			// every event until the stream ended — the opposite of the point.
			"x-accel-buffering": "no",
		},
	});
}
