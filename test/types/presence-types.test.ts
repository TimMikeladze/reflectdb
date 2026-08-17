import { describe, expect, test } from "bun:test";
import { defineSyncQueries, presence } from "../../src/core/schema.ts";
import { createSyncReact, derivePresenceKey } from "../../src/react/typed.ts";

// ── Test schema ─────────────────────────────────────────────────────────

const queries = defineSyncQueries({
	cursor: presence({
		state: {} as { x: number; y: number; name: string },
		params: {} as { gameId: string },
		ttlMs: 5000,
	}),
	heartbeat: presence({
		state: {} as { ts: number },
		// no params -> no params arg required
	}),
});

type Q = typeof queries;

// ── Tests ───────────────────────────────────────────────────────────────

describe("presence types", () => {
	test("usePresence with declared params typechecks; peers state is typed", () => {
		const { usePresence } = createSyncReact<Q>(queries);
		const _check = () => {
			const { peers, set } = usePresence("cursor", { gameId: "g1" });
			// peers[0].state is typed.
			const first = peers[0];
			if (first) {
				const _x: number = first.state.x;
				const _name: string = first.state.name;
				void _x;
				void _name;
			}
			// `set` accepts the typed state.
			void set({ x: 1, y: 2, name: "Alice" });
			// @ts-expect-error — wrong field type
			void set({ x: "not-a-number", y: 2, name: "Alice" });
		};
		void _check;
		expect(true).toBe(true);
	});

	test("usePresence requires params when declared", () => {
		const { usePresence } = createSyncReact<Q>(queries);
		const _check = () => {
			// @ts-expect-error — missing required params
			usePresence("cursor");
		};
		void _check;
		expect(true).toBe(true);
	});

	test("usePresence without declared params accepts no second arg", () => {
		const { usePresence } = createSyncReact<Q>(queries);
		const _check = () => {
			// "heartbeat" declares no params -> single-arg form is valid.
			const { peers } = usePresence("heartbeat");
			const first = peers[0];
			if (first) {
				const _ts: number = first.state.ts;
				void _ts;
			}
		};
		void _check;
		expect(true).toBe(true);
	});
});

describe("derivePresenceKey", () => {
	test("name-only key when no params", () => {
		expect(derivePresenceKey("cursor")).toBe("presence:cursor");
	});

	test("includes serialized params", () => {
		expect(derivePresenceKey("cursor", { gameId: "g1" })).toBe(
			'presence:cursor:{"gameId":"g1"}',
		);
	});

	test("stable across param key ordering", () => {
		const a = derivePresenceKey("cursor", { gameId: "g1", roomId: "r2" });
		const b = derivePresenceKey("cursor", { roomId: "r2", gameId: "g1" });
		expect(a).toBe(b);
	});
});
