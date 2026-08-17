import { describe, expect, test } from "bun:test";
import { createPollingServerTransport } from "../../src/transport/polling.ts";
import type { ServerMessage } from "../../src/core/types.ts";

describe("PollingServerTransport", () => {
	test("handleConnect registers client and fires connect handler", () => {
		const transport = createPollingServerTransport();
		let connected = "";
		transport.onConnect((clientId) => {
			connected = clientId;
		});

		transport.handleConnect("client1");
		expect(connected).toBe("client1");
	});

	test("handleMessage fires message handler", () => {
		const transport = createPollingServerTransport();
		let received: any = null;
		transport.onMessage((clientId, message) => {
			received = { clientId, message };
		});

		transport.handleMessage("client1", {
			type: "hello",
			protocolVersion: 1,
			clientId: "c1",
			token: "t",
		});

		expect(received).toBeDefined();
		expect(received.clientId).toBe("client1");
		expect(received.message.type).toBe("hello");
	});

	test("send queues message for connected client", async () => {
		const transport = createPollingServerTransport();
		transport.handleConnect("client1");

		const msg: ServerMessage = { type: "hello_ack", protocolVersion: 1, serverId: "s1" };
		await transport.send("client1", msg);

		const messages = transport.handlePoll("client1");
		expect(messages.length).toBe(1);
		expect(messages[0]).toEqual(msg);
	});

	test("send rejects for unknown client", async () => {
		const transport = createPollingServerTransport();
		// The broadcast engine commits a client's result cache only when send
		// resolves, so an undeliverable frame must report failure.
		expect(
			transport.send("unknown", { type: "hello_ack", protocolVersion: 1, serverId: "s1" }),
		).rejects.toThrow(/no queue registered/);
	});

	test("send rejects when the queue overflows and drops an undelivered message", async () => {
		const transport = createPollingServerTransport({ maxQueueLen: 2 });
		transport.handleConnect("c1");
		const msg = { type: "hello_ack", protocolVersion: 1, serverId: "s1" } as const;
		await transport.send("c1", msg);
		await transport.send("c1", msg);
		expect(transport.send("c1", msg)).rejects.toThrow(/overflow/);
	});

	test("handlePoll returns empty array for unknown client", () => {
		const transport = createPollingServerTransport();
		expect(transport.handlePoll("unknown")).toEqual([]);
	});

	test("handlePoll drains queue — second poll returns empty", async () => {
		const transport = createPollingServerTransport();
		transport.handleConnect("client1");

		const msg: ServerMessage = { type: "hello_ack", protocolVersion: 1, serverId: "s1" };
		await transport.send("client1", msg);
		await transport.send("client1", msg);

		const first = transport.handlePoll("client1");
		expect(first.length).toBe(2);

		const second = transport.handlePoll("client1");
		expect(second.length).toBe(0);
	});

	test("handlePoll returns empty for connected client with no messages", () => {
		const transport = createPollingServerTransport();
		transport.handleConnect("client1");

		expect(transport.handlePoll("client1")).toEqual([]);
	});

	test("handlePoll preserves message order", async () => {
		const transport = createPollingServerTransport();
		transport.handleConnect("client1");

		await transport.send("client1", {
			type: "hello_ack",
			protocolVersion: 1,
			serverId: "s1",
		} as ServerMessage);
		await transport.send("client1", { type: "disconnect", reason: "test" } as ServerMessage);

		const messages = transport.handlePoll("client1");
		expect(messages[0]!.type).toBe("hello_ack");
		expect(messages[1]!.type).toBe("disconnect");
	});

	test("handleDisconnect fires disconnect handler", () => {
		const transport = createPollingServerTransport();
		let disconnected = "";
		transport.onDisconnect((clientId) => {
			disconnected = clientId;
		});

		transport.handleConnect("client1");
		transport.handleDisconnect("client1");
		expect(disconnected).toBe("client1");
	});

	test("handleDisconnect removes client queue", async () => {
		const transport = createPollingServerTransport();
		transport.handleConnect("client1");

		await transport.send("client1", {
			type: "hello_ack",
			protocolVersion: 1,
			serverId: "s1",
		} as ServerMessage);
		transport.handleDisconnect("client1");

		expect(transport.handlePoll("client1")).toEqual([]);
	});

	test("broadcast sends to all connected clients", async () => {
		const transport = createPollingServerTransport();
		transport.handleConnect("c1");
		transport.handleConnect("c2");
		transport.handleConnect("c3");

		const msg: ServerMessage = { type: "hello_ack", protocolVersion: 1, serverId: "s1" };
		await transport.broadcast("room1", msg);

		expect(transport.handlePoll("c1").length).toBe(1);
		expect(transport.handlePoll("c2").length).toBe(1);
		expect(transport.handlePoll("c3").length).toBe(1);
	});

	test("broadcast excludes specified client", async () => {
		const transport = createPollingServerTransport();
		transport.handleConnect("c1");
		transport.handleConnect("c2");

		const msg: ServerMessage = { type: "hello_ack", protocolVersion: 1, serverId: "s1" };
		await transport.broadcast("room1", msg, "c1");

		expect(transport.handlePoll("c1").length).toBe(0);
		expect(transport.handlePoll("c2").length).toBe(1);
	});

	test("handleConnect is idempotent — does not clear existing queue", async () => {
		const transport = createPollingServerTransport();
		transport.handleConnect("c1");

		await transport.send("c1", {
			type: "hello_ack",
			protocolVersion: 1,
			serverId: "s1",
		} as ServerMessage);

		// Re-connect same client — should not lose queued messages
		transport.handleConnect("c1");

		expect(transport.handlePoll("c1").length).toBe(1);
	});

	test("close clears all client queues", async () => {
		const transport = createPollingServerTransport();
		transport.handleConnect("c1");
		transport.handleConnect("c2");

		await transport.send("c1", {
			type: "hello_ack",
			protocolVersion: 1,
			serverId: "s1",
		} as ServerMessage);
		await transport.send("c2", {
			type: "hello_ack",
			protocolVersion: 1,
			serverId: "s1",
		} as ServerMessage);

		await transport.close();

		expect(transport.handlePoll("c1")).toEqual([]);
		expect(transport.handlePoll("c2")).toEqual([]);
	});
});
