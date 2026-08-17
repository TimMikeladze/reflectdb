import { describe, expect, test } from "bun:test";
import { createSseServerTransport } from "../../src/transport/sse.ts";
import type { ServerMessage } from "../../src/core/types.ts";

describe("SseServerTransport", () => {
	test("createEventStream registers client and fires connect", () => {
		const transport = createSseServerTransport();
		let connected = "";
		transport.onConnect((clientId) => {
			connected = clientId;
		});

		const stream = transport.createEventStream("client1");
		// Reading the stream triggers the start callback
		const reader = stream.getReader();
		expect(connected).toBe("client1");
		reader.releaseLock();
	});

	test("handleMessage fires message handler", () => {
		const transport = createSseServerTransport();
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

	test("send writes SSE formatted data to stream", async () => {
		const transport = createSseServerTransport();
		const stream = transport.createEventStream("client1");
		const reader = stream.getReader();

		const msg: ServerMessage = {
			type: "hello_ack",
			protocolVersion: 1,
			serverId: "s1",
		};
		await transport.send("client1", msg);

		const { value, done } = await reader.read();
		expect(done).toBe(false);
		const text = new TextDecoder().decode(value);
		expect(text).toBe(`id: 1\ndata: ${JSON.stringify(msg)}\n\n`);
		reader.releaseLock();
	});

	test("handleDisconnect fires disconnect handler", () => {
		const transport = createSseServerTransport();
		let disconnected = "";
		transport.onDisconnect((clientId) => {
			disconnected = clientId;
		});

		transport.createEventStream("client1");
		transport.handleDisconnect("client1");
		expect(disconnected).toBe("client1");
	});

	test("send does nothing for unknown client", async () => {
		const transport = createSseServerTransport();
		// Should not throw
		await transport.send("unknown", {
			type: "hello_ack",
			protocolVersion: 1,
			serverId: "s1",
		});
	});
});
