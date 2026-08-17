import { describe, expect, test } from "bun:test";
import { validateClientMessage } from "../../src/server/message-validator.ts";

describe("validateClientMessage", () => {
	test("rejects non-object", () => {
		expect(validateClientMessage(null).valid).toBe(false);
		expect(validateClientMessage("hello").valid).toBe(false);
		expect(validateClientMessage(42).valid).toBe(false);
	});

	test("rejects missing type", () => {
		const result = validateClientMessage({ foo: "bar" });
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("invalid message type");
		}
	});

	test("rejects unknown type", () => {
		const result = validateClientMessage({ type: "garbage" });
		expect(result.valid).toBe(false);
	});

	test("validates hello message", () => {
		const valid = validateClientMessage({
			type: "hello",
			protocolVersion: 1,
			clientId: "c1",
			token: "tok",
		});
		expect(valid.valid).toBe(true);

		const noVersion = validateClientMessage({
			type: "hello",
			clientId: "c1",
			token: "tok",
		});
		expect(noVersion.valid).toBe(false);

		const noClient = validateClientMessage({
			type: "hello",
			protocolVersion: 1,
			token: "tok",
		});
		expect(noClient.valid).toBe(false);

		const noToken = validateClientMessage({
			type: "hello",
			protocolVersion: 1,
			clientId: "c1",
		});
		expect(noToken.valid).toBe(false);
	});

	test("validates bootstrap message (no required fields)", () => {
		expect(validateClientMessage({ type: "bootstrap" }).valid).toBe(true);
	});

	test("validates resume message", () => {
		expect(validateClientMessage({ type: "resume", since: "abc" }).valid).toBe(true);
		expect(validateClientMessage({ type: "resume" }).valid).toBe(false);
	});

	test("validates ops message", () => {
		const valid = validateClientMessage({
			type: "ops",
			token: "tok",
			ops: [{ id: "op1", table: "posts", op: "insert", rowId: "r1", hlc: "h1", payload: {} }],
		});
		expect(valid.valid).toBe(true);

		// Missing token
		expect(validateClientMessage({ type: "ops", ops: [] }).valid).toBe(false);

		// Invalid op type inside ops
		const badOp = validateClientMessage({
			type: "ops",
			token: "tok",
			ops: [{ id: "op1", table: "posts", op: "invalid", rowId: "r1", hlc: "h1" }],
		});
		expect(badOp.valid).toBe(false);

		// Missing id in op
		const noId = validateClientMessage({
			type: "ops",
			token: "tok",
			ops: [{ table: "posts", op: "insert", rowId: "r1", hlc: "h1" }],
		});
		expect(noId.valid).toBe(false);
	});

	test("validates sync_declare message", () => {
		expect(validateClientMessage({ type: "sync_declare", table: "posts" }).valid).toBe(true);
		expect(validateClientMessage({ type: "sync_declare" }).valid).toBe(false);
	});

	test("validates load_more message", () => {
		expect(validateClientMessage({ type: "load_more", table: "posts", count: 10 }).valid).toBe(
			true,
		);
		expect(validateClientMessage({ type: "load_more", table: "posts", count: 0 }).valid).toBe(
			false,
		);
		expect(validateClientMessage({ type: "load_more", table: "posts" }).valid).toBe(false);
	});

	test("validates unsync message", () => {
		expect(validateClientMessage({ type: "unsync", table: "posts" }).valid).toBe(true);
		expect(validateClientMessage({ type: "unsync" }).valid).toBe(false);
	});

	test("validates auth message", () => {
		expect(validateClientMessage({ type: "auth", token: "tok" }).valid).toBe(true);
		expect(validateClientMessage({ type: "auth" }).valid).toBe(false);
	});

	test("validates ephemeral message", () => {
		expect(validateClientMessage({ type: "ephemeral", key: "cursor", data: { x: 1 } }).valid).toBe(
			true,
		);
		expect(validateClientMessage({ type: "ephemeral", key: "cursor" }).valid).toBe(false);
		expect(validateClientMessage({ type: "ephemeral", data: {} }).valid).toBe(false);
	});

	test("rejects hello with empty or oversized clientId", () => {
		const baseHello = {
			type: "hello",
			protocolVersion: 1,
			token: "t",
		};
		expect(validateClientMessage({ ...baseHello, clientId: "" }).valid).toBe(false);
		expect(validateClientMessage({ ...baseHello, clientId: "x".repeat(300) }).valid).toBe(false);
		expect(validateClientMessage({ ...baseHello, clientId: "ok" }).valid).toBe(true);
	});

	test("rejects hello with oversized token", () => {
		expect(
			validateClientMessage({
				type: "hello",
				protocolVersion: 1,
				clientId: "c",
				token: "x".repeat(20_000),
			}).valid,
		).toBe(false);
	});

	test("rejects hello with malformed supportedVersions", () => {
		expect(
			validateClientMessage({
				type: "hello",
				protocolVersion: 1,
				clientId: "c",
				token: "t",
				supportedVersions: "nope",
			}).valid,
		).toBe(false);
		expect(
			validateClientMessage({
				type: "hello",
				protocolVersion: 1,
				clientId: "c",
				token: "t",
				supportedVersions: Array.from({ length: 50 }, (_, i) => i),
			}).valid,
		).toBe(false);
	});

	test("rejects op with non-object payload", () => {
		const baseOp = {
			id: "op1",
			table: "t",
			op: "insert",
			rowId: "r",
			hlc: "0000000000000000001.0000.client:a",
		};
		expect(
			validateClientMessage({ type: "ops", token: "t", ops: [{ ...baseOp, payload: "string" }] })
				.valid,
		).toBe(false);
		expect(
			validateClientMessage({ type: "ops", token: "t", ops: [{ ...baseOp, payload: [1, 2] }] })
				.valid,
		).toBe(false);
		expect(
			validateClientMessage({ type: "ops", token: "t", ops: [{ ...baseOp, payload: 42 }] })
				.valid,
		).toBe(false);
		expect(
			validateClientMessage({ type: "ops", token: "t", ops: [{ ...baseOp, payload: null }] })
				.valid,
		).toBe(true);
		expect(
			validateClientMessage({ type: "ops", token: "t", ops: [{ ...baseOp, payload: { a: 1 } }] })
				.valid,
		).toBe(true);
	});

	test("rejects oversized ops array", () => {
		const ops = Array.from({ length: 10_001 }, (_, i) => ({
			id: `op${i}`,
			table: "t",
			op: "insert",
			rowId: `r${i}`,
			hlc: "0000000000000000001.0000.client:a",
		}));
		const result = validateClientMessage({ type: "ops", token: "t", ops });
		expect(result.valid).toBe(false);
	});

	test("rejects load_more with absurd count", () => {
		expect(
			validateClientMessage({ type: "load_more", table: "t", count: 100_001 }).valid,
		).toBe(false);
		expect(
			validateClientMessage({ type: "load_more", table: "t", count: 1000 }).valid,
		).toBe(true);
	});
});
