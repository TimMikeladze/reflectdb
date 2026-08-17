import { describe, expect, test } from "bun:test";
import { SyncClient } from "../../src/client/sync-client.ts";
import type {
	ClientMessage,
	ClientTransport,
	OpsMessage,
	ServerMessage,
} from "../../src/core/types.ts";

function createMockClientTransport(): ClientTransport & {
	sentMessages: ClientMessage[];
	handler: ((message: ServerMessage) => void) | null;
	sendDelayMs: number;
	simulateMessage(message: ServerMessage): void;
} {
	const transport = {
		sentMessages: [] as ClientMessage[],
		handler: null as ((message: ServerMessage) => void) | null,
		sendDelayMs: 0,

		async send(message: ClientMessage): Promise<void> {
			if (transport.sendDelayMs > 0) {
				await new Promise((r) => setTimeout(r, transport.sendDelayMs));
			}
			transport.sentMessages.push(message);
		},
		subscribe(handler: (message: ServerMessage) => void): void {
			transport.handler = handler;
		},
		async close(): Promise<void> {},
		simulateMessage(message: ServerMessage): void {
			transport.handler?.(message);
		},
	};
	return transport;
}

function opsMessages(transport: ReturnType<typeof createMockClientTransport>): OpsMessage[] {
	return transport.sentMessages.filter((m): m is OpsMessage => m.type === "ops");
}

function totalOpsSent(transport: ReturnType<typeof createMockClientTransport>): number {
	return opsMessages(transport).reduce((sum, m) => sum + m.ops.length, 0);
}

describe("push coalescing", () => {
	test("does not resend ops that are already awaiting an ack", async () => {
		const transport = createMockClientTransport();
		const client = new SyncClient({
			clientId: "c1",
			transport,
			token: "t",
		});

		// The mutation hooks call push() after every edit. Resending the whole
		// pending set each time makes N edits cost 1+2+…+N ops on the wire.
		const N = 20;
		for (let i = 0; i < N; i++) {
			client.insert("posts", `r${i}`, { title: `t${i}` });
			await client.push();
		}

		expect(totalOpsSent(transport)).toBe(N);
		await client.close();
	});

	test("concurrent pushes coalesce instead of duplicating ops", async () => {
		const transport = createMockClientTransport();
		transport.sendDelayMs = 5;
		const client = new SyncClient({ clientId: "c1", transport, token: "t" });

		for (let i = 0; i < 10; i++) {
			client.insert("posts", `r${i}`, { title: `t${i}` });
		}
		// Ten un-awaited pushes fired in the same tick.
		await Promise.all(Array.from({ length: 10 }, () => client.push()));

		expect(totalOpsSent(transport)).toBe(10);
		const ids = opsMessages(transport).flatMap((m) => m.ops.map((o) => o.id));
		expect(new Set(ids).size).toBe(10);
		await client.close();
	});

	test("an awaited push includes ops created just before it", async () => {
		const transport = createMockClientTransport();
		transport.sendDelayMs = 5;
		const client = new SyncClient({ clientId: "c1", transport, token: "t" });

		client.insert("posts", "r1", { title: "one" });
		const first = client.push();
		client.insert("posts", "r2", { title: "two" });
		const second = client.push();
		await Promise.all([first, second]);

		const ids = opsMessages(transport).flatMap((m) => m.ops.map((o) => o.rowId));
		expect(ids).toContain("r1");
		expect(ids).toContain("r2");
		await client.close();
	});

	test("acked ops are dropped, unacked ops are not re-sent", async () => {
		const transport = createMockClientTransport();
		const client = new SyncClient({ clientId: "c1", transport, token: "t" });

		const op1 = client.insert("posts", "r1", { title: "one" });
		await client.push();
		transport.simulateMessage({ type: "ack", opIds: [op1.id] });

		client.insert("posts", "r2", { title: "two" });
		await client.push();

		const sent = opsMessages(transport).flatMap((m) => m.ops.map((o) => o.id));
		expect(sent).toEqual([op1.id, sent[1]!]);
		expect(sent.length).toBe(2);
		await client.close();
	});

	test("a disconnect frees pending ops for re-send", async () => {
		const transport = createMockClientTransport();
		const client = new SyncClient({ clientId: "c1", transport, token: "t", maxReconnectDelayMs: 60_000 });

		client.insert("posts", "r1", { title: "one" });
		await client.push();
		expect(totalOpsSent(transport)).toBe(1);

		// Never acked — the frame may not have landed, so the reconnect path
		// must be free to send it again.
		transport.simulateMessage({ type: "disconnect", reason: "ws_closed" });
		await client.push();

		expect(totalOpsSent(transport)).toBe(2);
		await client.close();
	});

	test("retries an op whose ack never arrived once the in-flight TTL lapses", async () => {
		const transport = createMockClientTransport();
		const client = new SyncClient({ clientId: "c1", transport, token: "t" });

		client.insert("posts", "r1", { title: "one" });
		await client.push();
		expect(totalOpsSent(transport)).toBe(1);

		// No ack, no disconnect — e.g. the server's queue dropped the frame.
		// Without a TTL the op would stay marked in-flight forever.
		await client.push();
		expect(totalOpsSent(transport)).toBe(1);

		const realNow = Date.now;
		Date.now = () => realNow() + 60_000;
		try {
			await client.push();
		} finally {
			Date.now = realNow;
		}
		expect(totalOpsSent(transport)).toBe(2);
		await client.close();
	});

	test("a failed send does not mark ops as in flight", async () => {
		const transport = createMockClientTransport();
		const failing: ClientTransport = {
			...transport,
			async send(message: ClientMessage) {
				if (message.type === "ops") throw new Error("socket down");
				return transport.send(message);
			},
			subscribe: transport.subscribe,
			close: transport.close,
		};
		const client = new SyncClient({ clientId: "c1", transport: failing, token: "t" });

		client.insert("posts", "r1", { title: "one" });
		await expect(client.push()).rejects.toThrow("socket down");

		// Retry must actually retry.
		await expect(client.push()).rejects.toThrow("socket down");
		await client.close();
	});
});
