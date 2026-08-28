/** Shared between the Vercel functions and the browser bundle. */

export const COLUMNS = ["todo", "doing", "done"] as const;

export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
	todo: "Todo",
	doing: "In progress",
	done: "Done",
};

export interface Card {
	id: string;
	title: string;
	column: Column;
	/**
	 * Sort key within a column. A float, not an index: dropping a card between
	 * two others averages its neighbours, so a move writes ONE row instead of
	 * renumbering everything below it. That matters here because every write is
	 * an object-storage round trip, and because two people reordering different
	 * parts of the same column would otherwise collide on rows neither touched.
	 */
	position: number;
}

export function isColumn(value: unknown): value is Column {
	return typeof value === "string" && (COLUMNS as readonly string[]).includes(value);
}

/**
 * Position for a card dropped between `before` and `after` (either may be
 * absent at the ends of a column).
 *
 * Averaging halves the gap each time, so ~50 drops into the same slot exhaust
 * float precision and two cards end up with equal positions. They then sort by
 * id, which is stable and consistent for everyone — ugly, not broken. A real
 * app would rebalance the column at that point.
 */
export function positionBetween(before: number | null, after: number | null): number {
	if (before === null && after === null) return 0;
	if (before === null) return (after as number) - 1;
	if (after === null) return before + 1;
	return (before + after) / 2;
}

/** Column order, then id so ties are resolved identically on every client. */
export function sortCards(cards: Card[]): Card[] {
	return [...cards].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
}
