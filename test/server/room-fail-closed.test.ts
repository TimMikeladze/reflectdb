import { describe, expect, test } from "bun:test";
import { createServer, buildRoomRegex } from "../../src/server/server.ts";
import { createMockTransport } from "./helpers.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type { ServerMessage } from "../../src/core/types.ts";

async function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function connectClient(
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
): Promise<void> {
	transport.connectHandler!(clientId, new Request("https://sync"));
	transport.messageHandler!(clientId, {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId,
		token: "valid",
	});
	await tick();
}

function rejectFor(
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
): Extract<ServerMessage, { type: "reject" }> | undefined {
	return transport.sentMessages.find(
		(m) => m.clientId === clientId && m.message.type === "reject",
	)?.message as Extract<ServerMessage, { type: "reject" }> | undefined;
}

function makeServer(roomOption?: string) {
	const transport = createMockTransport();
	const server = createServer({ db: {}, transport });
	server.auth(async () => ({ userId: "u1" }));
	let roomChecks = 0;
	server.room("org/:orgId/team/:teamId", () => {
		roomChecks++;
	});
	server.query("posts", () => Promise.resolve([]), {
		tables: ["posts"],
		room: roomOption,
		mutate: async () => {},
	});
	return { transport, server, roomChecks: () => roomChecks };
}

describe("room resolution fails closed", () => {
	test("omitting a room param is rejected, not silently unscoped", async () => {
		const { transport, server } = makeServer();
		await connectClient(transport, "c1");

		// Dropping teamId used to yield roomKey=null: no room callback ran and
		// the broadcast fanned out across every room.
		transport.messageHandler!("c1", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme" },
		});
		await tick();

		expect(rejectFor(transport, "c1")).toBeDefined();
		await server.close();
	});

	test("a param containing a slash is rejected", async () => {
		const { transport, server } = makeServer();
		await connectClient(transport, "c1");

		// "acme/evil" breaks the ([^/]+) capture, so the substituted key no
		// longer matches its own pattern.
		transport.messageHandler!("c1", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme/evil", teamId: "eng" },
		});
		await tick();

		expect(rejectFor(transport, "c1")).toBeDefined();
		await server.close();
	});

	test("a param value that looks like another placeholder is not re-substituted", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });
		server.auth(async () => ({ userId: "u1" }));
		const seen: Array<Record<string, string>> = [];
		server.room("org/:orgId/team/:teamId", ({ params }) => {
			seen.push(params);
		});
		server.query("posts", () => Promise.resolve([]), { tables: ["posts"] });

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: ":teamId", teamId: "eng" },
		});
		await tick();

		// Substituting one placeholder at a time would rewrite the injected
		// ":teamId" and hand the callback a room the params never described.
		expect(rejectFor(transport, "c1")).toBeUndefined();
		expect(seen).toEqual([{ orgId: ":teamId", teamId: "eng" }]);
		await server.close();
	});

	test("fully resolved params are accepted", async () => {
		const { transport, server, roomChecks } = makeServer();
		await connectClient(transport, "c1");

		transport.messageHandler!("c1", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme", teamId: "eng" },
		});
		await tick();

		expect(rejectFor(transport, "c1")).toBeUndefined();
		expect(roomChecks()).toBe(1);
		await server.close();
	});

	test("a query that addresses no room pattern stays global", async () => {
		const transport = createMockTransport();
		const server = createServer({ db: {}, transport });
		server.auth(async () => ({ userId: "u1" }));
		server.room("org/:orgId", () => {});
		server.query("me", () => Promise.resolve([]), { tables: ["me"] });

		await connectClient(transport, "c1");
		transport.messageHandler!("c1", { type: "sync_declare", table: "me" });
		await tick();

		expect(rejectFor(transport, "c1")).toBeUndefined();
		await server.close();
	});

	test("options.room requires the pattern even when params look global", async () => {
		const { transport, server } = makeServer("org/:orgId/team/:teamId");
		await connectClient(transport, "c1");

		transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
		await tick();

		expect(rejectFor(transport, "c1")).toBeDefined();
		await server.close();
	});
});

describe("buildRoomRegex", () => {
	test("escapes regex metacharacters in literal segments", () => {
		const { regex, paramNames } = buildRoomRegex("v1.0/org/:orgId");
		expect(paramNames).toEqual(["orgId"]);
		expect(regex.test("v1.0/org/acme")).toBe(true);
		// Unescaped, "." would match any character and let one room key
		// satisfy another room's ACL check.
		expect(regex.test("v1x0/org/acme")).toBe(false);
	});

	test("still captures multiple params", () => {
		const { regex, paramNames } = buildRoomRegex("org/:orgId/team/:teamId");
		expect(paramNames).toEqual(["orgId", "teamId"]);
		expect(regex.exec("org/acme/team/eng")?.slice(1)).toEqual(["acme", "eng"]);
	});
});
