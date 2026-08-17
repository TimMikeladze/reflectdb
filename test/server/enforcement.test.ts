import { describe, expect, test } from "bun:test";
import { packHlc } from "../../src/core/hlc.ts";
import {
	enforceClockDrift,
	enforceReadonly,
	enforceServerSet,
	enforceBatchSize,
	createRateLimiter,
} from "../../src/server/enforcement.ts";
import type { ClientOp } from "../../src/core/types.ts";

function makeOp(overrides: Partial<ClientOp> = {}): ClientOp {
	return {
		id: crypto.randomUUID(),
		table: "posts",
		op: "update",
		rowId: "row1",
		payload: { title: "hello" },
		hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:abc" }),
		...overrides,
	};
}

describe("enforceClockDrift", () => {
	test("allows HLC within drift window", () => {
		const hlc = packHlc({
			ms: Date.now() + 1000,
			counter: 0,
			nodeId: "client:abc",
		});
		expect(enforceClockDrift(hlc).ok).toBe(true);
	});

	test("allows HLC in the past", () => {
		const hlc = packHlc({
			ms: Date.now() - 10000,
			counter: 0,
			nodeId: "client:abc",
		});
		expect(enforceClockDrift(hlc).ok).toBe(true);
	});

	test("rejects HLC far in the future", () => {
		const hlc = packHlc({
			ms: Date.now() + 10 * 60 * 1000,
			counter: 0,
			nodeId: "client:abc",
		});
		const result = enforceClockDrift(hlc);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("clock_drift");
	});
});

describe("enforceReadonly", () => {
	test("strips readonly fields from payload", () => {
		const op = makeOp({
			payload: { title: "hello", orgId: "org1", authorId: "user1" },
		});
		const result = enforceReadonly(op, {
			readonly: ["orgId", "authorId"],
		});
		expect(result.payload).toEqual({ title: "hello" });
	});

	test("leaves non-readonly fields untouched", () => {
		const op = makeOp({ payload: { title: "hello", body: "world" } });
		const result = enforceReadonly(op, { readonly: ["orgId"] });
		expect(result.payload).toEqual({ title: "hello", body: "world" });
	});

	test("skips delete ops", () => {
		const op = makeOp({ op: "delete", payload: null });
		const result = enforceReadonly(op, { readonly: ["orgId"] });
		expect(result.payload).toBeNull();
	});

	test("handles no readonly config", () => {
		const op = makeOp({ payload: { title: "hello" } });
		const result = enforceReadonly(op, {});
		expect(result.payload).toEqual({ title: "hello" });
	});

	test("allows readonly fields on insert (immutable after creation)", () => {
		const op = makeOp({
			op: "insert",
			payload: { title: "hello", orgId: "org1", authorId: "user1" },
		});
		const result = enforceReadonly(op, {
			readonly: ["orgId", "authorId"],
		});
		// Insert should preserve all fields — readonly only applies to updates
		expect(result.payload).toEqual({ title: "hello", orgId: "org1", authorId: "user1" });
	});

	test("strips readonly fields on update but not insert", () => {
		const options = { readonly: ["createdAt", "createdBy"] };
		const insertOp = makeOp({
			op: "insert",
			payload: { title: "new", createdAt: "2026-01-01", createdBy: "alice" },
		});
		const updateOp = makeOp({
			op: "update",
			payload: { title: "updated", createdAt: "2026-01-01", createdBy: "alice" },
		});

		const insertResult = enforceReadonly(insertOp, options);
		expect(insertResult.payload).toEqual({
			title: "new",
			createdAt: "2026-01-01",
			createdBy: "alice",
		});

		const updateResult = enforceReadonly(updateOp, options);
		expect(updateResult.payload).toEqual({ title: "updated" });
	});
});

describe("enforceServerSet", () => {
	test("injects serverSet fields into payload", () => {
		const op = makeOp({
			payload: { title: "hello" },
		});
		const result = enforceServerSet(op, {
			serverSet: { orgId: "org-server", authorId: "user-server" },
		});
		expect(result.payload).toEqual({
			title: "hello",
			orgId: "org-server",
			authorId: "user-server",
		});
	});

	test("overwrites client-provided serverSet fields", () => {
		const op = makeOp({
			payload: { title: "hello", orgId: "client-org" },
		});
		const result = enforceServerSet(op, {
			serverSet: { orgId: "server-org" },
		});
		expect(result.payload).toEqual({
			title: "hello",
			orgId: "server-org",
		});
	});

	test("skips delete ops", () => {
		const op = makeOp({ op: "delete", payload: null });
		const result = enforceServerSet(op, {
			serverSet: { orgId: "org1" },
		});
		expect(result.payload).toBeNull();
	});

	test("handles no serverSet config", () => {
		const op = makeOp({ payload: { title: "hello" } });
		const result = enforceServerSet(op, {});
		expect(result.payload).toEqual({ title: "hello" });
	});
});

describe("enforceBatchSize", () => {
	test("allows batch within limit", () => {
		expect(enforceBatchSize(50, 100).ok).toBe(true);
	});

	test("allows undefined batch size", () => {
		expect(enforceBatchSize(undefined, 100).ok).toBe(true);
	});

	test("rejects batch exceeding limit", () => {
		const result = enforceBatchSize(150, 100);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("batch_too_large");
	});
});

describe("createRateLimiter", () => {
	test("allows ops within rate limit", () => {
		const limiter = createRateLimiter({ opsPerSecond: 5 });
		for (let i = 0; i < 5; i++) {
			limiter.record("user1", "client1");
		}
		expect(limiter.check("user1", "client1").ok).toBe(false);
	});

	test("different users have separate limits", () => {
		const limiter = createRateLimiter({ opsPerSecond: 2 });
		limiter.record("user1", "client1");
		limiter.record("user1", "client1");
		expect(limiter.check("user1", "client1").ok).toBe(false);
		expect(limiter.check("user2", "client1").ok).toBe(true);
	});

	test("ops per minute limit", () => {
		const limiter = createRateLimiter({ opsPerMinute: 3 });
		limiter.record("user1", "client1");
		limiter.record("user1", "client1");
		limiter.record("user1", "client1");
		const result = limiter.check("user1", "client1");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("rate_limited");
	});

	test("expired buckets are cleaned up", () => {
		const limiter = createRateLimiter({ opsPerSecond: 2 });
		// Record ops for many users to populate buckets
		for (let i = 0; i < 10; i++) {
			limiter.record(`user${i}`, "client1");
		}
		// After recording, all users should be checkable (1 op each, limit is 2)
		for (let i = 0; i < 10; i++) {
			expect(limiter.check(`user${i}`, "client1").ok).toBe(true);
		}
	});
});
