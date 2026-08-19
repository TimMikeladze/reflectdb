/**
 * Room lifetime for the demo.
 *
 * The deployment is a public sandbox on one small Fly Machine, so nothing is
 * kept: thirty minutes after a room is created it is deleted along with every
 * stroke, chat line, player row and round secret that belongs to it. The
 * sweeper on the server enforces it; the client reads the same constants to
 * show the countdown, so the two can never drift.
 *
 * Deliberately dependency-free — the browser bundle imports this module too.
 */

/** How long a room and its contents survive after the room is created. */
export const ROOM_TTL_MS = 30 * 60 * 1000;

/** How often the server sweeps for expired rooms. */
export const SWEEP_INTERVAL_MS = 30_000;

/**
 * Timestamps reach the client as whatever JSON.stringify made of the Date
 * drizzle handed back — an ISO string over the wire, a raw column value
 * (SQLite stores `mode: "timestamp"` in whole seconds) when a row is read
 * back locally. Normalize all of it to epoch milliseconds.
 */
export function timestampToMillis(value: unknown): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return 0;
		// Seconds-since-epoch never reaches 1e12 until the year 33658.
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
		const numeric = Number(value);
		if (Number.isFinite(numeric) && value.trim() !== "") {
			return numeric < 1e12 ? numeric * 1000 : numeric;
		}
	}
	return 0;
}

/** Epoch milliseconds at which a room created at `createdAt` is swept. */
export function roomExpiresAt(createdAt: unknown): number {
	const created = timestampToMillis(createdAt);
	return created === 0 ? 0 : created + ROOM_TTL_MS;
}

/** `m:ss` while under an hour, clamped at `0:00`. */
export function formatCountdown(remainingMs: number): string {
	const total = Math.max(0, Math.ceil(remainingMs / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
