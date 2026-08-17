import type { RoomRegistration } from "./handler.ts";

/** Outcome of mapping subscription params onto a registered room pattern. */
export type RoomResolution =
	| { ok: true; roomKey: string | null }
	| { ok: false; reason: string };

/**
 * Map subscription params onto a registered room pattern.
 *
 * FAIL CLOSED. Room keys come from client-supplied params, so silently
 * returning `null` for a half-resolved or malformed key hands the client a
 * room-ACL bypass: no room callback runs, and the broadcast falls back to
 * cross-room fanout. Two shapes are rejected outright:
 *
 *  - a pattern is partly addressed (`org/:orgId/team/:teamId` with `orgId`
 *    but no `teamId`) — omitting a param must not widen the scope;
 *  - every param is present but the substituted key fails the pattern
 *    (e.g. a value containing `/`, which breaks the `([^/]+)` capture).
 *
 * A subscription that addresses no room pattern at all is still fine —
 * that's a legitimately global query. Set `QueryOptions.room` to require a
 * specific pattern for a query.
 */
export function resolveRoomKey(
	rooms: readonly RoomRegistration[],
	params: Record<string, unknown>,
	requiredPattern?: string,
): RoomResolution {
	if (rooms.length === 0) {
		if (requiredPattern) {
			return {
				ok: false,
				reason: `Query requires room "${requiredPattern}" but no rooms are registered`,
			};
		}
		return { ok: true, roomKey: null };
	}

	for (const room of rooms) {
		if (requiredPattern && room.pattern !== requiredPattern) continue;

		// A pattern with no params matches unconditionally (legacy behavior).
		if (room.paramNames.length === 0) {
			return { ok: true, roomKey: room.pattern };
		}

		const provided = room.paramNames.filter(
			(name) => params[name] !== undefined && params[name] !== null,
		);
		// Not addressing this pattern at all is not an error — try the next.
		if (provided.length === 0) continue;
		if (provided.length < room.paramNames.length) {
			const missing = room.paramNames.filter((n) => !provided.includes(n));
			return {
				ok: false,
				reason: `Room "${room.pattern}" is missing param(s): ${missing.join(", ")}`,
			};
		}

		// Substitute in ONE pass. Replacing placeholders one at a time re-scans
		// text it just inserted, so a param whose value looks like another
		// placeholder (`:teamId`) would be substituted again — letting a client
		// steer its params onto a room key they don't describe. A single pass
		// also avoids `:x` matching the prefix of a `:xy` placeholder.
		const key = room.pattern.replace(/:(\w+)/g, (_, name: string) => String(params[name]));
		if (!room.regex.test(key)) {
			return {
				ok: false,
				reason: `Room "${room.pattern}" params do not form a valid room key`,
			};
		}
		return { ok: true, roomKey: key };
	}

	if (requiredPattern) {
		return {
			ok: false,
			reason: `Query requires room "${requiredPattern}" but params do not resolve it`,
		};
	}
	return { ok: true, roomKey: null };
}
