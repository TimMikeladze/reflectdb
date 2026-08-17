import { describe, expect, test } from "bun:test";
import { packHlc } from "../../src/core/hlc.ts";
import { MutationError } from "../../src/core/types.ts";
import { resolveConflict } from "../../src/server/conflict.ts";
import type { ConflictInput, ExistingRow } from "../../src/server/conflict.ts";

const hlc1 = packHlc({ ms: 1000, counter: 0, nodeId: "client:a" });
const hlc2 = packHlc({ ms: 2000, counter: 0, nodeId: "client:b" });
const hlc3 = packHlc({ ms: 3000, counter: 0, nodeId: "client:a" });

function makeIncoming(overrides: Partial<ConflictInput> = {}): ConflictInput {
	return {
		op: "update",
		payload: { title: "new" },
		hlc: hlc2,
		rowId: "row1",
		tableName: "posts",
		userId: "user1",
		...overrides,
	};
}

function makeExisting(overrides: Partial<ExistingRow> = {}): ExistingRow {
	return {
		row: { title: "old", body: "existing" },
		rowHlc: hlc1,
		colClocks: { _row: hlc1, title: hlc1, body: hlc1 },
		...overrides,
	};
}

describe("LWW conflict resolution", () => {
	test("accepts op with newer HLC", () => {
		const result = resolveConflict(
			"lww",
			makeIncoming({ hlc: hlc2 }),
			makeExisting({ rowHlc: hlc1 }),
		);
		expect(result.accepted).toBe(true);
		// LWW update merges incoming payload with existing row
		expect(result.resolvedRow).toEqual({ title: "new", body: "existing" });
	});

	test("rejects op with older HLC", () => {
		const result = resolveConflict(
			"lww",
			makeIncoming({ hlc: hlc1 }),
			makeExisting({ rowHlc: hlc2 }),
		);
		expect(result.accepted).toBe(false);
		expect(result.resolvedRow).toEqual({ title: "old", body: "existing" });
	});

	test("accepts insert on non-existent row", () => {
		const result = resolveConflict(
			"lww",
			makeIncoming({ op: "insert", payload: { title: "first" } }),
			{ row: null, rowHlc: null, colClocks: {} },
		);
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toEqual({ title: "first" });
	});

	test("accepts delete with newer HLC", () => {
		const result = resolveConflict(
			"lww",
			makeIncoming({ op: "delete", payload: null, hlc: hlc3 }),
			makeExisting({ rowHlc: hlc1 }),
		);
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toBeNull();
	});

	test("rejects delete with older HLC", () => {
		const result = resolveConflict(
			"lww",
			makeIncoming({ op: "delete", payload: null, hlc: hlc1 }),
			makeExisting({ rowHlc: hlc2 }),
		);
		expect(result.accepted).toBe(false);
	});
});

describe("Merge conflict resolution", () => {
	test("merges per-column when incoming is newer", () => {
		const result = resolveConflict(
			"merge",
			makeIncoming({
				hlc: hlc2,
				payload: { title: "new-title" },
			}),
			makeExisting({
				rowHlc: hlc1,
				colClocks: { _row: hlc1, title: hlc1, body: hlc1 },
			}),
		);
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toEqual({
			title: "new-title",
			body: "existing",
		});
		expect(result.updatedColClocks["title"]).toBe(hlc2);
		expect(result.updatedColClocks["body"]).toBe(hlc1);
	});

	test("rejects column update when existing column clock is newer", () => {
		const result = resolveConflict(
			"merge",
			makeIncoming({
				hlc: hlc1,
				payload: { title: "stale-title" },
			}),
			makeExisting({
				rowHlc: hlc2,
				colClocks: { _row: hlc2, title: hlc2, body: hlc1 },
			}),
		);
		expect(result.accepted).toBe(false);
		expect(result.resolvedRow).toEqual({ title: "old", body: "existing" });
		// All cols lost — distinct reason so client doesn't retry as server_error
		expect(result.reason).toBe("merge_stale");
	});

	test("merge_stale reason when ALL columns lose (no winning cols)", () => {
		const result = resolveConflict(
			"merge",
			makeIncoming({
				hlc: hlc1,
				payload: { title: "stale-1", body: "stale-2" },
			}),
			makeExisting({
				rowHlc: hlc3,
				colClocks: { _row: hlc3, title: hlc3, body: hlc2 },
			}),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("merge_stale");
		// existing state preserved exactly
		expect(result.resolvedRow).toEqual({ title: "old", body: "existing" });
		expect(result.updatedColClocks["title"]).toBe(hlc3);
		expect(result.updatedColClocks["body"]).toBe(hlc2);
	});

	test("delete losing to newer row HLC sets merge_stale reason", () => {
		const result = resolveConflict(
			"merge",
			makeIncoming({ op: "delete", payload: null, hlc: hlc1 }),
			makeExisting({ rowHlc: hlc2 }),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("merge_stale");
	});

	test("partially merges: accepts newer columns, rejects older", () => {
		const result = resolveConflict(
			"merge",
			makeIncoming({
				hlc: hlc2,
				payload: { title: "new-title", body: "new-body" },
			}),
			makeExisting({
				rowHlc: hlc1,
				colClocks: { _row: hlc1, title: hlc3, body: hlc1 },
			}),
		);
		expect(result.accepted).toBe(true);
		// title should NOT be updated (hlc3 > hlc2)
		expect(result.resolvedRow).toEqual({
			title: "old",
			body: "new-body",
		});
		expect(result.updatedColClocks["title"]).toBe(hlc3);
		expect(result.updatedColClocks["body"]).toBe(hlc2);
	});

	test("accepts insert on non-existent row", () => {
		const result = resolveConflict(
			"merge",
			makeIncoming({ op: "insert", payload: { title: "first" } }),
			{ row: null, rowHlc: null, colClocks: {} },
		);
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toEqual({ title: "first" });
	});

	test("delete uses row-level HLC", () => {
		const result = resolveConflict(
			"merge",
			makeIncoming({ op: "delete", payload: null, hlc: hlc3 }),
			makeExisting({ rowHlc: hlc2 }),
		);
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toBeNull();
	});
});

describe("Server conflict resolution", () => {
	test("accepts first write (no existing row)", () => {
		const result = resolveConflict("server", makeIncoming({ op: "insert" }), {
			row: null,
			rowHlc: null,
			colClocks: {},
		});
		expect(result.accepted).toBe(true);
	});

	test("rejects subsequent writes to existing row", () => {
		const result = resolveConflict("server", makeIncoming({ op: "update" }), makeExisting());
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("server_conflict");
	});
});

describe("Custom conflict resolution", () => {
	test("calls resolver with correct arguments", () => {
		let calledWith: any = null;
		const result = resolveConflict(
			{
				policy: "custom",
				resolve: (incoming, existing, meta) => {
					calledWith = { incoming, existing, meta };
					return { row: { ...existing.row, ...incoming.payload } };
				},
			},
			makeIncoming({ payload: { title: "merged" } }),
			makeExisting(),
		);

		expect(result.accepted).toBe(true);
		expect(calledWith.incoming.payload).toEqual({ title: "merged" });
		expect(calledWith.existing.row).toEqual({
			title: "old",
			body: "existing",
		});
		expect(calledWith.meta.table).toBe("posts");
		expect(calledWith.meta.rowId).toBe("row1");
	});

	test("additive counter merge", () => {
		const result = resolveConflict(
			{
				policy: "custom",
				resolve: (incoming, existing) => ({
					row: {
						...existing.row,
						count: (existing.row.count as number) + ((incoming.payload?.delta as number) ?? 0),
					},
				}),
			},
			makeIncoming({ payload: { delta: 5 } }),
			{
				row: { count: 10 },
				rowHlc: hlc1,
				colClocks: { _row: hlc1, count: hlc1 },
			},
		);
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toEqual({ count: 15 });
	});

	test("resolver throwing plain Error becomes server_error (not custom_conflict)", () => {
		const result = resolveConflict(
			{
				policy: "custom",
				resolve: () => {
					throw new Error("db connection lost");
				},
			},
			makeIncoming(),
			makeExisting(),
		);
		expect(result.accepted).toBe(false);
		// Real bug surface, not policy rejection
		expect(result.reason).toBe("server_error");
	});

	test("resolver throwing MutationError preserves custom reason", () => {
		const result = resolveConflict(
			{
				policy: "custom",
				resolve: () => {
					throw new MutationError("custom_conflict", "policy denied");
				},
			},
			makeIncoming(),
			makeExisting(),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("custom_conflict");
	});

	test("resolver throwing MutationError with mutation_rejected preserves it", () => {
		const result = resolveConflict(
			{
				policy: "custom",
				resolve: () => {
					throw new MutationError("mutation_rejected", "validation");
				},
			},
			makeIncoming(),
			makeExisting(),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("mutation_rejected");
	});

	test("does not advance _row HLC when resolver returns no-op", () => {
		const result = resolveConflict(
			{
				policy: "custom",
				resolve: (_incoming, existing) => ({ row: { ...existing.row } }),
			},
			makeIncoming({ payload: { title: "old" } }),
			makeExisting(),
		);
		expect(result.accepted).toBe(true);
		// _row stays at hlc1 because nothing changed
		expect(result.updatedColClocks._row).toBe(hlc1);
	});

	test("advances _row HLC when resolver changes a column", () => {
		const result = resolveConflict(
			{
				policy: "custom",
				resolve: (_incoming, existing) => ({ row: { ...existing.row, title: "new" } }),
			},
			makeIncoming({ payload: { title: "new" } }),
			makeExisting(),
		);
		expect(result.accepted).toBe(true);
		expect(result.updatedColClocks._row).toBe(hlc2);
		expect(result.updatedColClocks.title).toBe(hlc2);
	});

	test("accepts insert on non-existent row without calling resolver", () => {
		let resolverCalled = false;
		const result = resolveConflict(
			{
				policy: "custom",
				resolve: () => {
					resolverCalled = true;
					return { row: {} };
				},
			},
			makeIncoming({ op: "insert", payload: { title: "first" } }),
			{ row: null, rowHlc: null, colClocks: {} },
		);
		expect(result.accepted).toBe(true);
		expect(resolverCalled).toBe(false);
	});
});
