/**
 * Periodic reset for the public demo board.
 *
 * The board is open to anyone with the link, so it fills up with whatever
 * visitors leave. Rather than a cron job, the reset is LAZY: every request
 * checks whether the current five-minute window has been reset yet, and the
 * first one to notice does it. That has three properties a cron does not:
 *
 *   - It works on any plan. Vercel's Hobby tier caps cron jobs at one run per
 *     day, so `*​/5 * * * *` is not deployable there at all.
 *   - A board nobody is looking at costs nothing. No visitors, no requests, no
 *     resets — which is the same argument the rest of this example makes about
 *     idle rooms.
 *   - The board a visitor sees is never stale. The reset runs *before* their
 *     snapshot is built, so they cannot briefly see the previous window's cards.
 *
 * Writes go through `handler.applyServerOp`, not `storage.putRow`. The op log is
 * what other invocations poll (`getOplogHead`), so a bare row write would be
 * invisible to every tab already open — they would keep rendering the cards this
 * function just deleted until they reconnected.
 */

import { PreconditionFailedError } from "../../../src/server/storage/object/types.ts";
import type { Board } from "./board.ts";
import { type Card, sortCards } from "../schema.ts";

/** How long a window of visitor edits survives, on every board without exception. */
export const RESET_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The cards the board is reset to.
 *
 * Stable ids, so a reset overwrites the previous window's copies rather than
 * accumulating a new set of rows every five minutes.
 */
export const SEED_CARDS: readonly Card[] = [
	{ id: "seed-drag", title: "Drag me into In progress", column: "todo", position: 0 },
	{ id: "seed-tab", title: "Open this board in a second tab", column: "todo", position: 1 },
	{ id: "seed-bucket", title: "Every card here is an object in an S3 bucket", column: "todo", position: 2 },
	{ id: "seed-tape", title: "Watch the strip above tick as writes land", column: "doing", position: 0 },
	{ id: "seed-reset", title: "Every board here resets every 5 minutes", column: "done", position: 0 },
];

/** Which five-minute window `now` falls in. Shared by every instance because it is derived from the clock alone. */
export function resetWindow(now: number = Date.now()): number {
	return Math.floor(now / RESET_INTERVAL_MS);
}

/**
 * Key whose creation claims one window of `boardId`.
 *
 * "Claimed" means the window's reset has already been decided, NOT that a reset
 * happened: a window that opened on an already-pristine board is claimed by the
 * first request to look at it, having done nothing. Both readings have to be the
 * same one, or an edit made after a no-op window is treated as a board that
 * still owes a reset. See `resetIfDue`.
 */
function claimKey(boardId: string, window: number): string {
	return `resets/${encodeURIComponent(boardId)}/${window}`;
}

/** True when the board already holds exactly the seed cards, so a reset would be a no-op. */
function isPristine(cards: Card[]): boolean {
	if (cards.length !== SEED_CARDS.length) return false;
	const ordered = sortCards(cards);
	const expected = sortCards([...SEED_CARDS]);
	return ordered.every((card, i) => {
		const want = expected[i]!;
		return (
			card.id === want.id &&
			card.title === want.title &&
			card.column === want.column &&
			card.position === want.position
		);
	});
}

/**
 * Claims this window for this instance.
 *
 * `ifNoneMatch: "*"` is the same create-if-absent primitive the manifest seeds
 * itself with, so exactly one of N racing invocations wins and the rest see
 * `PreconditionFailedError` and skip. MinIO rejects the wildcard (see
 * `ObjectDriverCapabilities.casWildcard`), and there the check degrades to
 * read-then-write: two instances can both win and both reset, which writes the
 * same seed rows twice and is harmless.
 */
async function claim(board: Board, boardId: string, window: number): Promise<boolean> {
	const key = claimKey(boardId, window);

	if (!board.driver.caps.casWildcard) {
		if (await board.driver.get(key)) return false;
		await board.driver.put(key, new Uint8Array(0));
		return true;
	}

	try {
		await board.driver.put(key, new Uint8Array(0), { ifNoneMatch: "*" });
		return true;
	} catch (error) {
		if (error instanceof PreconditionFailedError) return false;
		throw error;
	}
}

/** Drops claim markers from earlier windows so the prefix does not grow without bound. */
async function forgetOldClaims(board: Board, boardId: string, window: number): Promise<void> {
	const prefix = `resets/${encodeURIComponent(boardId)}/`;
	const stale = (await board.driver.list(prefix))
		.map((entry) => entry.key)
		.filter((key) => {
			const suffix = Number(key.slice(prefix.length));
			return Number.isFinite(suffix) && suffix < window;
		});
	if (stale.length > 0) await board.driver.delete(stale);
}

/**
 * Resets the board if the current window has not been reset yet.
 *
 * Returns whether this call performed the reset. Safe to call on every request
 * and on every poll tick: once a window is claimed every later call is one small
 * GET that finds the marker and stops.
 */
export async function resetIfDue(
	board: Board,
	boardId: string,
	now: number = Date.now(),
): Promise<boolean> {
	const window = resetWindow(now);

	// The claim is the whole decision, and it is taken on the window rather than
	// on the board's contents. Reading the cards first and skipping out early
	// when they are pristine looks like the cheaper test and is the wrong one: a
	// window that opens on a clean board leaves nothing claimed, so the first
	// visitor edit makes the board dirty inside a window that still looks unspent,
	// and the next request to arrive — the other tab's `hello`, a second drag,
	// anything — claims it and resets the board out from under them. The card
	// snapping back the instant a second tab speaks is that bug.
	//
	// Costs one small GET on the common path, which is the price of the check
	// being correct. The write is only attempted in the window's first request.
	if (await isClaimed(board, boardId, window)) return false;
	if (!(await claim(board, boardId, window))) return false;
	await forgetOldClaims(board, boardId, window);

	// EVERY board resets, including one reached through `?board=<slug>`. This is
	// a public demo with no sign-in, so there is nowhere to put data that is
	// meant to last — a board that quietly kept its contents would be inviting
	// people to rely on storage this example does not offer. The five-minute
	// window is the promise, and it applies uniformly.
	const cards = (await board.storage.getRows("cards")).rows as unknown as Card[];
	// Nothing to undo, but the window is spent either way: whoever edits next is
	// entitled to keep that edit until the clock rolls over.
	if (isPristine(cards)) return false;

	await resetBoard(board, cards);
	return true;
}

/** Whether this window's reset has already been decided by some other request. */
async function isClaimed(board: Board, boardId: string, window: number): Promise<boolean> {
	return Boolean(await board.driver.get(claimKey(boardId, window)));
}

/**
 * Deletes every card, then writes the seed set.
 *
 * Deletes first so a card a visitor happened to give a seed id is replaced
 * rather than merged with — `applyServerOp`'s update path merges onto what is
 * stored, and a leftover column from someone else's edit is exactly the kind of
 * state this function exists to remove.
 */
async function resetBoard(board: Board, cards: Card[]): Promise<void> {
	for (const card of cards) {
		await board.handler.applyServerOp({
			type: "delete",
			table: "cards",
			rowId: card.id,
			payload: null,
		});
	}

	for (const card of SEED_CARDS) {
		await board.handler.applyServerOp({
			type: "insert",
			table: "cards",
			rowId: card.id,
			payload: { ...card },
		});
	}

	// The reset is only real once it is in the bucket; until then the next
	// invocation still reads the previous window's cards and resets again.
	await board.storage.flush();
}
