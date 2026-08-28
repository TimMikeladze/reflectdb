/**
 * Clears every board in the kanban demo bucket.
 *
 * The `demo` board resets itself on a five-minute window (examples/kanban/lib/reset.ts);
 * this is the blunt version, for the boards `?board=<slug>` created and nothing
 * cleans up. The adapter rebuilds each board from nothing on the next request.
 *
 * Reads the same environment as the deployed functions — `createKanbanDriver` is
 * the single source of truth for which bucket that is, so this cannot drift into
 * wiping a different one than the app writes to.
 */
import { createKanbanDriver } from "../examples/kanban/lib/board.ts";

const driver = createKanbanDriver();

// `resets/` too: the claim markers are keyed by window, so leaving them behind
// would let the current window's marker suppress the reset of a board this
// script just emptied.
for (const prefix of ["rooms/", "resets/"]) {
	const keys = (await driver.list(prefix)).map((entry) => entry.key);
	console.log(`${prefix} deleting ${keys.length} object(s)`);
	if (keys.length > 0) await driver.delete(keys);
	console.log(`${prefix} remaining: ${(await driver.list(prefix)).length}`);
}
