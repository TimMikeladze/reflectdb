import { describe, expect, test, beforeEach } from "bun:test";
import { MessageHandler } from "../../src/server/handler.ts";
import type { SyncEvent } from "../../src/server/types.ts";
import { createMockTransport } from "./helpers.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import { packHlc } from "../../src/core/hlc.ts";

async function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("Observability events", () => {
	let transport: ReturnType<typeof createMockTransport>;
	let events: SyncEvent[];
	let handler: MessageHandler;

	beforeEach(() => {
		transport = createMockTransport();
		events = [];
		handler = new MessageHandler({
			transport,
			serverId: "test",
			db: {},
			onEvent: (e) => events.push(e),
		});
		handler.setAuth(async () => ({ userId: "user1" }));
	});

	test("emits client_connected on connect", async () => {
		transport.connectHandler!("client1", new Request("https://sync"));
		expect(events).toContainEqual({ type: "client_connected", clientId: "client1" });
	});

	test("emits client_disconnected on disconnect", async () => {
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.disconnectHandler!("client1");
		expect(events).toContainEqual({ type: "client_disconnected", clientId: "client1" });
	});

	test("emits auth_failed when auth throws", async () => {
		handler.setAuth(async () => {
			throw new Error("db down");
		});

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "bad",
		});
		await tick();

		const authFailed = events.find((e) => e.type === "auth_failed");
		expect(authFailed).toBeDefined();
	});

	test("emits message_invalid for bad messages", async () => {
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", { type: "garbage" } as never);
		await tick();

		const invalid = events.find((e) => e.type === "message_invalid");
		expect(invalid).toBeDefined();
	});

	test("emits bootstrap event", async () => {
		handler.setQuery("posts", {
			name: "posts",
			callback: () => [],
			tableDependencies: new Set(["posts"]),
			options: { tables: ["posts"], conflict: "lww" },
		});

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();

		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		await tick();

		transport.messageHandler!("client1", { type: "bootstrap" });
		await tick();

		const bootstrap = events.find((e) => e.type === "bootstrap");
		expect(bootstrap).toBeDefined();
		if (bootstrap && bootstrap.type === "bootstrap") {
			expect(bootstrap.queries).toBe(1);
		}
	});

	test("emits ops_processed event", async () => {
		handler.setQuery("posts", {
			name: "posts",
			callback: () => [],
			tableDependencies: new Set(["posts"]),
			options: {
				tables: ["posts"],
				conflict: "lww",
				mutate: async () => {},
			},
		});

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();

		transport.messageHandler!("client1", { type: "sync_declare", table: "posts" });
		await tick();

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "valid",
			ops: [
				{
					id: "op-1",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "test" },
					hlc,
				},
			],
		});
		await tick();

		const opsEvent = events.find((e) => e.type === "ops_processed");
		expect(opsEvent).toBeDefined();
		if (opsEvent && opsEvent.type === "ops_processed") {
			expect(opsEvent.accepted).toBe(1);
			expect(opsEvent.rejected).toBe(0);
		}
	});

	test("emits auth_failed on re-auth failure", async () => {
		// Authenticate successfully first
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();

		// Now make auth fail for re-auth
		handler.setAuth(async () => {
			throw new Error("token expired");
		});

		transport.messageHandler!("client1", { type: "auth", token: "expired" });
		await tick();

		const authFailed = events.filter((e) => e.type === "auth_failed");
		expect(authFailed.length).toBe(1);
	});

	test("emits auth_failed on ops auth failure", async () => {
		handler.setQuery("posts", {
			name: "posts",
			callback: () => [],
			tableDependencies: new Set(["posts"]),
			options: { tables: ["posts"], conflict: "lww", mutate: async () => {} },
		});

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();

		// Now make auth fail for ops push
		handler.setAuth(async () => {
			throw new Error("token expired");
		});

		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client1", {
			type: "ops",
			token: "expired",
			ops: [
				{
					id: "op-auth-fail",
					table: "posts",
					op: "insert",
					rowId: "r1",
					payload: { title: "test" },
					hlc,
				},
			],
		});
		await tick();

		const authFailed = events.filter((e) => e.type === "auth_failed");
		expect(authFailed.length).toBe(1);

		// Should also get a reauth message
		const reauth = transport.sentMessages.find((m) => m.message.type === "reauth");
		expect(reauth).toBeDefined();
	});

	test("auth_failed event includes the error object", async () => {
		const dbError = new Error("db connection refused");
		handler.setAuth(async () => {
			throw dbError;
		});

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "bad",
		});
		await tick();

		const authFailed = events.find((e) => e.type === "auth_failed");
		expect(authFailed).toBeDefined();
		if (authFailed && authFailed.type === "auth_failed") {
			expect(authFailed.clientId).toBe("client1");
			expect(authFailed.error).toBe(dbError);
		}
	});

	test("re-auth failure sends disconnect, ops auth failure sends reauth", async () => {
		handler.setQuery("posts", {
			name: "posts",
			callback: () => [],
			tableDependencies: new Set(["posts"]),
			options: { tables: ["posts"], conflict: "lww", mutate: async () => {} },
		});

		// Connect and authenticate
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();
		transport.sentMessages.length = 0; // clear hello_ack

		// Make auth fail
		handler.setAuth(async () => {
			throw new Error("expired");
		});

		// re-auth path → disconnect
		transport.messageHandler!("client1", { type: "auth", token: "expired" });
		await tick();

		const disconnect = transport.sentMessages.find((m) => m.message.type === "disconnect");
		expect(disconnect).toBeDefined();

		// Reset for ops path — need a new client since the first got disconnected
		transport.sentMessages.length = 0;
		handler.setAuth(async () => ({ userId: "user1" })); // fix auth first
		transport.connectHandler!("client2", new Request("https://sync"));
		transport.messageHandler!("client2", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client2",
			token: "valid",
		});
		await tick();
		transport.messageHandler!("client2", { type: "sync_declare", table: "posts" });
		await tick();
		transport.sentMessages.length = 0;

		// Now break auth again
		handler.setAuth(async () => {
			throw new Error("expired");
		});
		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "client:a" });
		transport.messageHandler!("client2", {
			type: "ops",
			token: "expired",
			ops: [{ id: "op-x", table: "posts", op: "insert", rowId: "r1", payload: {}, hlc }],
		});
		await tick();

		// ops path → reauth (not disconnect)
		const reauth = transport.sentMessages.find((m) => m.message.type === "reauth");
		expect(reauth).toBeDefined();
		const opsDisconnect = transport.sentMessages.find((m) => m.message.type === "disconnect");
		expect(opsDisconnect).toBeUndefined();
	});

	test("emits ephemeral_full when capacity exceeded", async () => {
		// Each client gets a unique userId so ephemeral entries are distinct
		let callCount = 0;
		handler.setAuth(async () => ({ userId: `user${++callCount}` }));
		handler.setMaxEphemeralEntries(2);

		handler.setRoom({
			pattern: "room/:roomId",
			regex: /^room\/([^/]+)$/,
			paramNames: ["roomId"],
			callback: async () => ({ ok: true }),
		});

		handler.setQuery("chat", {
			name: "chat",
			callback: () => [],
			tableDependencies: new Set(["messages"]),
			options: { tables: ["messages"], conflict: "lww" },
		});

		// Connect 3 clients with distinct userIds, subscribe with room params
		for (const id of ["c1", "c2", "c3"]) {
			transport.connectHandler!(id, new Request("https://sync"));
			transport.messageHandler!(id, {
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				clientId: id,
				token: "valid",
			});
			await tick();
			transport.messageHandler!(id, {
				type: "sync_declare",
				table: "chat",
				params: { roomId: "room1" },
			});
			await tick();
		}

		// Send ephemeral from c1 and c2 — should succeed (2 entries, cap = 2)
		transport.messageHandler!("c1", { type: "ephemeral", key: "cursor", data: { x: 1 } });
		await tick();
		transport.messageHandler!("c2", { type: "ephemeral", key: "cursor", data: { x: 2 } });
		await tick();

		// No ephemeral_full yet
		expect(events.filter((e) => e.type === "ephemeral_full").length).toBe(0);

		// Send from c3 — should hit capacity (3rd userId, cap is 2)
		transport.messageHandler!("c3", { type: "ephemeral", key: "cursor", data: { x: 3 } });
		await tick();

		const fullEvent = events.find((e) => e.type === "ephemeral_full");
		expect(fullEvent).toBeDefined();
		if (fullEvent && fullEvent.type === "ephemeral_full") {
			expect(fullEvent.currentSize).toBe(2);
		}
	});

	test("ephemeral_full prevents broadcast to other clients", async () => {
		let callCount = 0;
		handler.setAuth(async () => ({ userId: `user${++callCount}` }));
		handler.setMaxEphemeralEntries(1);

		handler.setRoom({
			pattern: "room/:roomId",
			regex: /^room\/([^/]+)$/,
			paramNames: ["roomId"],
			callback: async () => ({ ok: true }),
		});

		handler.setQuery("chat", {
			name: "chat",
			callback: () => [],
			tableDependencies: new Set(["messages"]),
			options: { tables: ["messages"], conflict: "lww" },
		});

		// Connect 2 clients in same room with distinct userIds
		for (const id of ["c1", "c2"]) {
			transport.connectHandler!(id, new Request("https://sync"));
			transport.messageHandler!(id, {
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				clientId: id,
				token: "valid",
			});
			await tick();
			transport.messageHandler!(id, {
				type: "sync_declare",
				table: "chat",
				params: { roomId: "room1" },
			});
			await tick();
		}

		// Fill capacity with c1's ephemeral
		transport.messageHandler!("c1", { type: "ephemeral", key: "cursor", data: { x: 1 } });
		await tick();

		// Count ephemeral messages sent to c1 so far
		const beforeCount = transport.sentMessages.filter(
			(m) => m.clientId === "c1" && m.message.type === "ephemeral",
		).length;

		// c2 tries to send — should be rejected at capacity (different userId)
		transport.messageHandler!("c2", { type: "ephemeral", key: "cursor", data: { x: 2 } });
		await tick();

		const afterCount = transport.sentMessages.filter(
			(m) => m.clientId === "c1" && m.message.type === "ephemeral",
		).length;

		// c1 should NOT have received c2's ephemeral (rejected before broadcast)
		expect(afterCount).toBe(beforeCount);
	});

	test("hello is rejected when no auth callback is configured", async () => {
		const noAuthHandler = new MessageHandler({
			transport,
			serverId: "test",
			db: {},
			onEvent: (e) => events.push(e),
		});
		// No setAuth call — no auth callback

		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "tok",
		});
		await tick();

		// Acking hello here would leave the client stuck: every later message
		// fails the "Not authenticated" gate. Fail the handshake instead.
		expect(transport.sentMessages.find((m) => m.message.type === "hello_ack")).toBeUndefined();
		const reject = transport.sentMessages.find((m) => m.message.type === "hello_reject");
		expect(reject).toBeDefined();
		expect((reject!.message as { reason: string }).reason).toContain("auth()");

		// Not an auth *failure* — there was no callback to fail.
		expect(events.filter((e) => e.type === "auth_failed").length).toBe(0);
		await noAuthHandler.close();
	});

	test("allowAnonymous serves connections with a synthetic identity", async () => {
		const anonHandler = new MessageHandler({
			transport,
			serverId: "test",
			db: {},
			allowAnonymous: true,
			onEvent: (e) => events.push(e),
		});

		transport.connectHandler!("client-anon", new Request("https://sync"));
		transport.messageHandler!("client-anon", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client-anon",
			token: "tok",
		});
		await tick();

		expect(transport.sentMessages.find((m) => m.message.type === "hello_ack")).toBeDefined();
		expect(anonHandler.getSessions().get("client-anon")?.auth?.userId).toBe("anon:client-anon");
		await anonHandler.close();
	});

	test("onEvent errors don't crash the handler", async () => {
		const badHandler = new MessageHandler({
			transport,
			serverId: "test",
			onEvent: () => {
				throw new Error("observer crashed");
			},
		});
		badHandler.setAuth(async () => ({ userId: "user1" }));

		// Should not throw
		transport.connectHandler!("client1", new Request("https://sync"));
		transport.messageHandler!("client1", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "client1",
			token: "valid",
		});
		await tick();

		// Handler still works
		const ack = transport.sentMessages.find((m) => m.message.type === "hello_ack");
		expect(ack).toBeDefined();
	});
});
