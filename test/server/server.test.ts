import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { buildRoomRegex } from "../../src/server/server.ts";
import { createMockTransport } from "./helpers.ts";

describe("createServer", () => {
	test("creates server with defaults", () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
		});
		expect(server).toBeDefined();
		expect(server.auth).toBeFunction();
		expect(server.query).toBeFunction();
		expect(server.room).toBeFunction();
		expect(server.rateLimit).toBeFunction();
		expect(server.compaction).toBeFunction();
		expect(server.minSchemaVersion).toBeFunction();
		expect(server.close).toBeFunction();
	});

	test("auth callback can be registered", () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
		});
		server.auth(async () => ({ userId: "user1" }));
	});

	test("query callback can be registered", () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
		});
		server.query("posts", (ctx, db) => {}, {
			tables: ["posts"],
			conflict: "merge",
			mutate: async () => {},
		});
	});

	test("room callback can be registered", () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
		});
		server.room("org/:orgId", (ctx) => {
			// room auth logic
		});
	});

	test("rateLimit can be configured", () => {
		const transport = createMockTransport();
		const server = createServer({
			db: {},
			transport,
		});
		server.rateLimit({ opsPerSecond: 50, opsPerMinute: 500 });
	});

	test("close delegates to transport", async () => {
		let closed = false;
		const transport = createMockTransport();
		const originalClose = transport.close;
		transport.close = async () => {
			closed = true;
		};
		const server = createServer({
			db: {},
			transport,
		});
		await server.close();
		expect(closed).toBe(true);
	});
});

describe("buildRoomRegex", () => {
	test("matches simple pattern", () => {
		const { regex, paramNames } = buildRoomRegex("org/:orgId");
		expect(paramNames).toEqual(["orgId"]);
		expect(regex.test("org/abc123")).toBe(true);
		expect(regex.test("org/")).toBe(false);
		expect(regex.test("other/abc")).toBe(false);
	});

	test("extracts params from match", () => {
		const { regex, paramNames } = buildRoomRegex("org/:orgId/channel/:channelId");
		expect(paramNames).toEqual(["orgId", "channelId"]);
		const match = "org/abc/channel/xyz".match(regex);
		expect(match).toBeTruthy();
		expect(match![1]).toBe("abc");
		expect(match![2]).toBe("xyz");
	});

	test("static pattern with no params", () => {
		const { regex, paramNames } = buildRoomRegex("global");
		expect(paramNames).toEqual([]);
		expect(regex.test("global")).toBe(true);
		expect(regex.test("other")).toBe(false);
	});
});
