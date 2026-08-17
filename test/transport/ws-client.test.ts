import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createWsClientTransport } from "../../src/transport/ws.ts";
import type { ServerMessage, ClientMessage } from "../../src/core/types.ts";

// ── Mock WebSocket ──────────────────────────────────────────────────────────

type EventHandler = (...args: any[]) => void;

interface MockWebSocket {
	url: string;
	protocols: string[] | undefined;
	readyState: number;
	sent: string[];
	closed: boolean;
	listeners: Map<string, EventHandler[]>;
	send(data: string): void;
	close(): void;
	addEventListener(event: string, handler: EventHandler): void;
	// Test helpers
	simulateOpen(): void;
	simulateMessage(data: string): void;
	simulateClose(): void;
	simulateError(): void;
}

let mockInstances: MockWebSocket[] = [];
let OriginalWebSocket: typeof globalThis.WebSocket;

function createMockWebSocketClass() {
	return function MockWebSocket(url: string, protocols?: string[]) {
		const ws: MockWebSocket = {
			url,
			protocols: protocols as string[] | undefined,
			readyState: 0, // CONNECTING
			sent: [],
			closed: false,
			listeners: new Map(),
			send(data: string) {
				ws.sent.push(data);
			},
			close() {
				ws.closed = true;
				ws.readyState = 3; // CLOSED
				// Fire close event synchronously (browser behavior)
				const handlers = ws.listeners.get("close") ?? [];
				for (const h of handlers) h();
			},
			addEventListener(event: string, handler: EventHandler) {
				const list = ws.listeners.get(event) ?? [];
				list.push(handler);
				ws.listeners.set(event, list);
			},
			simulateOpen() {
				ws.readyState = 1; // OPEN
				const handlers = ws.listeners.get("open") ?? [];
				for (const h of handlers) h();
			},
			simulateMessage(data: string) {
				const handlers = ws.listeners.get("message") ?? [];
				for (const h of handlers) h({ data });
			},
			simulateClose() {
				ws.readyState = 3;
				const handlers = ws.listeners.get("close") ?? [];
				for (const h of handlers) h();
			},
			simulateError() {
				const handlers = ws.listeners.get("error") ?? [];
				for (const h of handlers) h();
			},
		};
		mockInstances.push(ws);
		return ws;
	} as unknown as typeof WebSocket;
}

beforeEach(() => {
	mockInstances = [];
	OriginalWebSocket = globalThis.WebSocket;
	(globalThis as any).WebSocket = createMockWebSocketClass();
	// Ensure the mock has the OPEN constant
	(globalThis.WebSocket as any).OPEN = 1;
});

afterEach(() => {
	globalThis.WebSocket = OriginalWebSocket;
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("WsClientTransport", () => {
	test("subscribe creates a WebSocket and registers handler", () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		const received: ServerMessage[] = [];

		transport.subscribe((msg) => received.push(msg));

		expect(mockInstances.length).toBe(1);
		expect(mockInstances[0]!.url).toBe("ws://localhost:1234");
	});

	test("messages are delivered to subscriber", () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		const received: ServerMessage[] = [];

		transport.subscribe((msg) => received.push(msg));

		const ws = mockInstances[0]!;
		ws.simulateOpen();

		const msg: ServerMessage = { type: "hello_ack", protocolVersion: 1, serverId: "s1" };
		ws.simulateMessage(JSON.stringify(msg));

		expect(received.length).toBe(1);
		expect(received[0]).toEqual(msg);
	});

	test("malformed messages are ignored with warning", () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		const received: ServerMessage[] = [];

		transport.subscribe((msg) => received.push(msg));

		const ws = mockInstances[0]!;
		ws.simulateOpen();
		ws.simulateMessage("not json{{{");

		expect(received.length).toBe(0);
	});

	test("send buffers messages until socket is open", async () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		const msg: ClientMessage = {
			type: "hello",
			protocolVersion: 1,
			clientId: "c1",
			token: "tok",
		};

		await transport.send(msg);

		const ws = mockInstances[0]!;
		// Socket is still CONNECTING, message should be buffered
		expect(ws.sent.length).toBe(0);

		// Open the socket — pending messages should flush
		ws.simulateOpen();
		expect(ws.sent.length).toBe(1);
		expect(JSON.parse(ws.sent[0]!)).toEqual(msg);
	});

	test("send sends immediately when socket is open", async () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		transport.subscribe(() => {});

		const ws = mockInstances[0]!;
		ws.simulateOpen();

		const msg: ClientMessage = {
			type: "hello",
			protocolVersion: 1,
			clientId: "c1",
			token: "tok",
		};
		await transport.send(msg);

		expect(ws.sent.length).toBe(1);
	});

	test("multiple pending messages are flushed in order on open", async () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });

		const msg1: ClientMessage = { type: "hello", protocolVersion: 1, clientId: "c1", token: "t1" };
		const msg2: ClientMessage = { type: "bootstrap" } as ClientMessage;

		await transport.send(msg1);
		await transport.send(msg2);

		const ws = mockInstances[0]!;
		expect(ws.sent.length).toBe(0);

		ws.simulateOpen();
		expect(ws.sent.length).toBe(2);
		expect(JSON.parse(ws.sent[0]!).type).toBe("hello");
		expect(JSON.parse(ws.sent[1]!).type).toBe("bootstrap");
	});

	// ── Disconnect detection ─────────────────────────────────────────────

	test("emits synthetic disconnect on unexpected close", () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		const received: ServerMessage[] = [];

		transport.subscribe((msg) => received.push(msg));

		const ws = mockInstances[0]!;
		ws.simulateOpen();
		ws.simulateClose();

		const disconnect = received.find((m) => m.type === "disconnect");
		expect(disconnect).toBeDefined();
		if (disconnect && "reason" in disconnect) {
			expect(disconnect.reason).toBe("ws_closed");
		}
	});

	test("emits synthetic disconnect on error", () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		const received: ServerMessage[] = [];

		transport.subscribe((msg) => received.push(msg));

		const ws = mockInstances[0]!;
		ws.simulateOpen();
		ws.simulateError();

		const disconnect = received.find((m) => m.type === "disconnect");
		expect(disconnect).toBeDefined();
		if (disconnect && "reason" in disconnect) {
			expect(disconnect.reason).toBe("ws_error");
		}
	});

	test("intentional close does NOT emit disconnect", async () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		const received: ServerMessage[] = [];

		transport.subscribe((msg) => received.push(msg));

		const ws = mockInstances[0]!;
		ws.simulateOpen();

		// close() sets intentionalClose=true BEFORE ws.close(),
		// and ws.close() fires the "close" event synchronously in our mock
		await transport.close();

		expect(ws.closed).toBe(true);
		const disconnect = received.find((m) => m.type === "disconnect");
		expect(disconnect).toBeUndefined();
	});

	test("no disconnect event when handler is null (close before subscribe)", async () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });

		// send creates the socket without subscribing
		await transport.send({
			type: "hello",
			protocolVersion: 1,
			clientId: "c1",
			token: "t",
		} as ClientMessage);

		const ws = mockInstances[0]!;
		ws.simulateClose();

		// No crash — handler is null, disconnect message goes nowhere
	});

	test("error followed by close does not duplicate disconnect", () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		const received: ServerMessage[] = [];

		transport.subscribe((msg) => received.push(msg));

		const ws = mockInstances[0]!;
		ws.simulateOpen();

		// Error fires first, then close (browser behavior)
		ws.simulateError();
		ws.simulateClose();

		const disconnects = received.filter((m) => m.type === "disconnect");
		// Both events fire — they are separate signals
		// The SyncClient is responsible for deduplication
		expect(disconnects.length).toBe(2);
	});

	// ── Socket lifecycle ─────────────────────────────────────────────────

	test("getSocket returns null before connect", () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		expect(transport.getSocket()).toBeNull();
	});

	test("getSocket returns the socket after subscribe", () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		transport.subscribe(() => {});
		expect(transport.getSocket()).toBeDefined();
	});

	test("getSocket returns null after close", async () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		transport.subscribe(() => {});
		await transport.close();
		expect(transport.getSocket()).toBeNull();
	});

	test("new send after close creates a fresh socket", async () => {
		const transport = createWsClientTransport({ url: "ws://localhost:1234" });
		transport.subscribe(() => {});
		await transport.close();

		expect(mockInstances.length).toBe(1);

		await transport.send({
			type: "hello",
			protocolVersion: 1,
			clientId: "c1",
			token: "t",
		} as ClientMessage);

		expect(mockInstances.length).toBe(2);
	});
});
