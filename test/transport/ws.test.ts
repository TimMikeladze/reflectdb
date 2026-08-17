import { describe, expect, test } from "bun:test";
import { createWsServerTransport } from "../../src/transport/ws.ts";
import type { WebSocketLike } from "../../src/transport/ws.ts";
import type { ServerMessage } from "../../src/core/types.ts";

function createMockWs(): WebSocketLike & { sent: string[]; closed: boolean } {
	const ws = {
		sent: [] as string[],
		closed: false,
		readyState: 1,
		bufferedAmount: 0,
		send(data: string): void {
			ws.sent.push(data);
		},
		close(): void {
			ws.closed = true;
		},
	};
	return ws;
}

describe("WsServerTransport", () => {
	test("handleOpen registers client and fires connect", () => {
		const transport = createWsServerTransport();
		let connected = "";
		transport.onConnect((clientId) => {
			connected = clientId;
		});

		const ws = createMockWs();
		transport.handleOpen("client1", ws);
		expect(connected).toBe("client1");
	});

	test("handleMessage parses JSON and fires message handler", () => {
		const transport = createWsServerTransport();
		let received: any = null;
		transport.onMessage((clientId, message) => {
			received = { clientId, message };
		});

		transport.handleOpen("client1", createMockWs());
		transport.handleMessage(
			"client1",
			JSON.stringify({ type: "hello", protocolVersion: 1, clientId: "c1", token: "t" }),
		);

		expect(received).toBeDefined();
		expect(received.clientId).toBe("client1");
		expect(received.message.type).toBe("hello");
	});

	test("handleMessage ignores malformed JSON", () => {
		const transport = createWsServerTransport();
		let called = false;
		transport.onMessage(() => {
			called = true;
		});

		transport.handleMessage("client1", "not json{{{");
		expect(called).toBe(false);
	});

	test("handleClose removes client and fires disconnect", () => {
		const transport = createWsServerTransport();
		let disconnected = "";
		transport.onDisconnect((clientId) => {
			disconnected = clientId;
		});

		transport.handleOpen("client1", createMockWs());
		transport.handleClose("client1");
		expect(disconnected).toBe("client1");
	});

	test("send serializes message to WebSocket", async () => {
		const transport = createWsServerTransport();
		const ws = createMockWs();
		transport.handleOpen("client1", ws);

		const msg: ServerMessage = {
			type: "hello_ack",
			protocolVersion: 1,
			serverId: "s1",
		};
		await transport.send("client1", msg);

		expect(ws.sent.length).toBe(1);
		expect(JSON.parse(ws.sent[0]!)).toEqual(msg);
	});

	test("send rejects for unknown client", async () => {
		const transport = createWsServerTransport();
		// The broadcast engine commits a client's result cache only when send
		// resolves, so an undeliverable frame must report failure.
		expect(
			transport.send("unknown", {
				type: "hello_ack",
				protocolVersion: 1,
				serverId: "s1",
			}),
		).rejects.toThrow(/no socket registered/);
	});

	test("send rejects when the socket is not OPEN", async () => {
		const transport = createWsServerTransport();
		const ws = createMockWs();
		ws.readyState = 3; // CLOSED
		transport.handleOpen("client1", ws);

		expect(
			transport.send("client1", { type: "hello_ack", protocolVersion: 1, serverId: "s1" }),
		).rejects.toThrow(/not open/);
		expect(ws.sent.length).toBe(0);
	});

	test("send rejects when the outbound buffer is over the backpressure limit", async () => {
		const transport = createWsServerTransport({ maxBufferedBytes: 100 });
		const ws = createMockWs();
		ws.readyState = 1;
		ws.bufferedAmount = 5000;
		transport.handleOpen("client1", ws);

		expect(
			transport.send("client1", { type: "hello_ack", protocolVersion: 1, serverId: "s1" }),
		).rejects.toThrow(/outbound buffer over limit/);
	});

	test("close closes all client sockets", async () => {
		const transport = createWsServerTransport();
		const ws1 = createMockWs();
		const ws2 = createMockWs();
		transport.handleOpen("c1", ws1);
		transport.handleOpen("c2", ws2);

		await transport.close();
		expect(ws1.closed).toBe(true);
		expect(ws2.closed).toBe(true);
	});
});
