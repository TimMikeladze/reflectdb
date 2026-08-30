/** Shared between the sync server and the browser bundle. */

import { defineSyncQueries, t } from "../../src/core/index.ts";

/**
 * A type alias, not an interface: `t<Row>()` requires the row to be assignable
 * to `Record<string, unknown>`, and only type aliases get that implicit index
 * signature. An interface here silently degrades every inferred row to
 * `unknown` downstream.
 */
export type Todo = {
	id: string;
	text: string;
	done: boolean;
	/** Epoch millis. A number rather than a Date so it survives JSON intact. */
	createdAt: number;
};

export const queries = defineSyncQueries({
	todos: {
		row: t<Todo>(),
		conflict: "lww",
		// Clients cannot forge a creation time, so ordering is the server's.
		serverSet: ["createdAt"],
	},
});

export type AppQueries = typeof queries;
