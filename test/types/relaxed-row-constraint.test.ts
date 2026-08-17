import { describe, test, expect } from "bun:test";
import type {
	useSync as ReactUseSync,
	useRow as ReactUseRow,
} from "../../src/react/hooks.ts";
import type { SyncStore } from "../../src/svelte/stores.ts";
import type { TableBinding, VanillaSync } from "../../src/vanilla/sync.ts";

// ── Types under test ────────────────────────────────────────────────────

// Exact shape — no `& Record<string, unknown>` tax.
type Game = {
	id: string;
	name: string;
	createdAt: Date;
};

// ── Helpers ─────────────────────────────────────────────────────────────

function assertType<T>(_value: T): void {}

// ── Tests ───────────────────────────────────────────────────────────────

describe("P10: relaxed Record<string, unknown> row constraint", () => {
	test("react useSync<Game> compiles without record cast", () => {
		// Type-level only — never invoked.
		const _check = (_useSync: typeof ReactUseSync) => {
			const result = _useSync<Game>("games");
			assertType<Game[]>(result.rows);
			assertType<(rowId: string, payload: Partial<Game>) => void>(result.insert);
			assertType<(rowId: string, payload: Partial<Game>) => void>(result.update);
			assertType<(rowId: string) => void>(result.remove);
		};
		// Reference variable so the closure compiles.
		void _check;
		expect(true).toBe(true);
	});

	test("react useRow<Game> compiles without record cast", () => {
		const _check = (_useRow: typeof ReactUseRow) => {
			const row = _useRow<Game>("games", "g-1");
			assertType<Game | null>(row);
		};
		void _check;
		expect(true).toBe(true);
	});

	test("svelte sync<Game> compiles without record cast", () => {
		const _check = (store: SyncStore) => {
			const result = store.sync<Game>("games");
			assertType<(rowId: string, payload: Partial<Game>) => void>(result.insert);
			assertType<(rowId: string, payload: Partial<Game>) => void>(result.update);
			assertType<(rowId: string) => void>(result.remove);
		};
		void _check;
		expect(true).toBe(true);
	});

	test("svelte row<Game> compiles without record cast", () => {
		const _check = (store: SyncStore) => {
			const row = store.row<Game>("games", "g-1");
			assertType<typeof row>(row);
		};
		void _check;
		expect(true).toBe(true);
	});

	test("vanilla TableBinding<Game> + sync<Game> compile without record cast", () => {
		// Type-level only — never invoked.
		const _check = (binding: TableBinding<Game>, sync: VanillaSync) => {
			assertType<Game[]>(binding.getRows());
			const result = sync.sync<Game>("games");
			assertType<TableBinding<Game>>(result);
			const row = sync.getRow<Game>("games", "g-1");
			assertType<Game | null>(row);
		};
		void _check;
		expect(true).toBe(true);
	});

	test("non-object T (e.g. string) is still rejected", () => {
		// Negative cases — these must NOT compile.
		const _negative = (_useSync: typeof ReactUseSync) => {
			// @ts-expect-error — string is not an object.
			_useSync<string>("games");
			// @ts-expect-error — number is not an object.
			_useSync<number>("games");
		};
		void _negative;
		expect(true).toBe(true);
	});
});
