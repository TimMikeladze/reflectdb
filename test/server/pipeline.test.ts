import { describe, expect, test } from "bun:test";
import { packHlc } from "../../src/core/hlc.ts";
import { processOp } from "../../src/server/pipeline.ts";
import type { PipelineContext } from "../../src/server/pipeline.ts";
import type { ExistingRow } from "../../src/server/conflict.ts";
import { createRateLimiter } from "../../src/server/enforcement.ts";
import type { ClientOp } from "../../src/core/types.ts";

const now = Date.now();
const hlcOld = packHlc({ ms: now - 5000, counter: 0, nodeId: "client:a" });
const hlcNew = packHlc({ ms: now, counter: 0, nodeId: "client:b" });
const hlcNewer = packHlc({ ms: now + 1000, counter: 0, nodeId: "client:a" });

function makeOp(overrides: Partial<ClientOp> = {}): ClientOp {
	return {
		id: crypto.randomUUID(),
		table: "posts",
		op: "update",
		rowId: "row1",
		payload: { title: "new" },
		hlc: hlcNew,
		...overrides,
	};
}

function makeExisting(overrides: Partial<ExistingRow> = {}): ExistingRow {
	return {
		row: { title: "old", body: "existing" },
		rowHlc: hlcOld,
		colClocks: { _row: hlcOld, title: hlcOld, body: hlcOld },
		...overrides,
	};
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
	return {
		userId: "user1",
		nodeId: "client:a",
		options: {},
		conflict: "lww",
		...overrides,
	};
}

const noExisting: ExistingRow = { row: null, rowHlc: null, colClocks: {} };

describe("processOp pipeline", () => {
	// ── Happy path ──────────────────────────────────────────────────────

	test("accepts a valid update with newer HLC", () => {
		const result = processOp(makeOp(), makeExisting(), makeCtx());
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toEqual({ title: "new", body: "existing" });
	});

	test("accepts an insert on non-existent row", () => {
		const op = makeOp({ op: "insert", payload: { title: "first" } });
		const result = processOp(op, noExisting, makeCtx());
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toEqual({ title: "first" });
	});

	test("accepts a delete with newer HLC", () => {
		const op = makeOp({ op: "delete", payload: null, hlc: hlcNewer });
		const result = processOp(op, makeExisting(), makeCtx());
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toBeNull();
	});

	// ── Clock drift rejection ───────────────────────────────────────────

	test("rejects op with HLC far in the future", () => {
		const futureHlc = packHlc({
			ms: Date.now() + 10 * 60 * 1000,
			counter: 0,
			nodeId: "client:a",
		});
		const op = makeOp({ hlc: futureHlc });
		const result = processOp(op, makeExisting(), makeCtx());
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("clock_drift");
	});

	// ── Rate limiting ───────────────────────────────────────────────────

	test("rejects when rate limited", () => {
		const limiter = createRateLimiter({ opsPerSecond: 2 });
		const ctx = makeCtx({ rateLimiter: limiter });

		// Use up the rate limit
		limiter.record("user1", "client:a");
		limiter.record("user1", "client:a");

		const result = processOp(makeOp(), makeExisting(), ctx);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("rate_limited");
	});

	test("records rate limit on successful check", () => {
		const limiter = createRateLimiter({ opsPerSecond: 2 });
		const ctx = makeCtx({ rateLimiter: limiter });

		// First op succeeds and records
		processOp(makeOp(), noExisting, ctx);

		// Second op succeeds and records
		processOp(makeOp(), noExisting, ctx);

		// Third op should be rate limited
		const result = processOp(makeOp(), noExisting, ctx);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("rate_limited");
	});

	// ── Batch size ──────────────────────────────────────────────────────

	test("rejects batch exceeding max size", () => {
		const op = makeOp({ batchSize: 200 });
		const result = processOp(op, makeExisting(), makeCtx({ maxBatchSize: 100 }));
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("batch_too_large");
	});

	test("allows batch within max size", () => {
		const op = makeOp({ batchSize: 50 });
		const result = processOp(op, noExisting, makeCtx({ maxBatchSize: 100 }));
		expect(result.accepted).toBe(true);
	});

	// ── Readonly enforcement ────────────────────────────────────────────

	test("strips readonly fields before conflict resolution", () => {
		const op = makeOp({
			payload: { title: "new", orgId: "client-org" },
		});
		const result = processOp(op, noExisting, makeCtx({ options: { readonly: ["orgId"] } }));
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toEqual({ title: "new" });
		expect(result.op.payload).toEqual({ title: "new" });
	});

	// ── ServerSet enforcement ───────────────────────────────────────────

	test("injects serverSet fields before conflict resolution", () => {
		const op = makeOp({ payload: { title: "new" } });
		const result = processOp(
			op,
			noExisting,
			makeCtx({ options: { serverSet: { orgId: "server-org" } } }),
		);
		expect(result.accepted).toBe(true);
		expect(result.resolvedRow).toEqual({ title: "new", orgId: "server-org" });
		expect(result.op.payload).toEqual({ title: "new", orgId: "server-org" });
	});

	// ── Conflict resolution flows through ───────────────────────────────

	test("rejects update with older HLC (LWW)", () => {
		const op = makeOp({ hlc: hlcOld });
		const existing = makeExisting({ rowHlc: hlcNew });
		const result = processOp(op, existing, makeCtx());
		expect(result.accepted).toBe(false);
		expect(result.resolvedRow).toEqual({ title: "old", body: "existing" });
	});

	test("merge policy partially accepts columns", () => {
		const hlcVeryOld = packHlc({ ms: now - 10000, counter: 0, nodeId: "client:c" });
		const op = makeOp({
			hlc: hlcNew,
			payload: { title: "new-title", body: "new-body" },
		});
		const existing = makeExisting({
			rowHlc: hlcVeryOld,
			colClocks: { _row: hlcVeryOld, title: hlcNewer, body: hlcVeryOld },
		});
		const result = processOp(op, existing, makeCtx({ conflict: "merge" }));
		expect(result.accepted).toBe(true);
		// title stays old (hlcNewer > hlcNew), body gets updated
		expect(result.resolvedRow).toEqual({ title: "old", body: "new-body" });
	});

	test("server policy rejects writes to existing rows", () => {
		const result = processOp(makeOp(), makeExisting(), makeCtx({ conflict: "server" }));
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("server_conflict");
	});

	// ── Combined enforcement ────────────────────────────────────────────

	test("readonly + serverSet combined", () => {
		const op = makeOp({
			payload: { title: "new", secret: "hack", orgId: "client-org" },
		});
		const result = processOp(
			op,
			noExisting,
			makeCtx({
				options: {
					readonly: ["secret"],
					serverSet: { orgId: "server-org" },
				},
			}),
		);
		expect(result.accepted).toBe(true);
		// secret stripped, orgId overwritten by server
		expect(result.resolvedRow).toEqual({ title: "new", orgId: "server-org" });
	});

	// ── Pipeline returns transformed op ─────────────────────────────────

	test("returned op reflects all transformations", () => {
		const op = makeOp({
			payload: { title: "new", admin: "true" },
		});
		const result = processOp(
			op,
			noExisting,
			makeCtx({
				options: {
					readonly: ["admin"],
					serverSet: { createdBy: "server-user" },
				},
			}),
		);
		expect(result.op.payload).toEqual({
			title: "new",
			createdBy: "server-user",
		});
	});
});
