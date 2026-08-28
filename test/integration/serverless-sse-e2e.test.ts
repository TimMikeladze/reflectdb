import { afterAll, describe, expect, test } from "bun:test";
import { SyncClient } from "../../src/client/sync-client.ts";
import { MessageHandler } from "../../src/server/handler.ts";
import { createMemoryDriver } from "../../src/server/storage/object/drivers/memory.ts";
import {
	createObjectStorage,
	type ObjectStorage,
} from "../../src/server/storage/object/index.ts";
import { ProcessMemoryBudget } from "../../src/server/storage/object/state.ts";
import type { ObjectDriver } from "../../src/server/storage/object/types.ts";
import { createSseClientTransport, createSseServerTransport } from "../../src/transport/sse.ts";
import type { ClientMessage } from "../../src/core/types.ts";

/**
 * The serverless deployment shape, modelled honestly: the POST that carries a
 * client message and the GET that holds its event stream are handled by TWO
 * SEPARATE server processes, each with its own `MessageHandler`, sharing only an
 * object-storage bucket. That is what Vercel does, and it is what breaks a
 * naive SSE port — replies to the POST would be enqueued onto a stream the
 * POST's process does not have.
 */

const opened: ObjectStorage[] = [];
afterAll(async () => {
	await Promise.allSettled(opened.map((s) => s.close()));
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
	for (let i = 0; i < 12; i++) await tick();
};

/** One serverless invocation: its own handler and its own adapter over the shared bucket. */
function createInvocation(driver: ObjectDriver, roomId: string, serverId: string) {
	const storage = createObjectStorage(
		{ driver, roomId, concurrency: "optimistic" },
		{ budget: new ProcessMemoryBudget() },
	);
	opened.push(storage);

	const transport = createSseServerTransport({ serverless: true });
	const handler = new MessageHandler({ transport, serverId, db: {} });
	handler.setStorage(storage);
	handler.setAuth(async () => ({ userId: "user1" }));
	handler.setQuery("cards", {
		name: "cards",
		callback: async () => (await storage.getRows("cards")).rows,
		tableDependencies: new Set(["cards"]),
		options: {
			tables: ["cards"],
			conflict: "lww",
			mutate: async (op) => {
				if (op.type === "delete") {
					await storage.putRow("cards", op.rowId, null, {}, op.hlc);
				} else {
					await storage.putRow("cards", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
				}
			},
		},
	});

	return { storage, transport, handler };
}

describe("serverless SSE over object storage", () => {
	test("a client completes the handshake when POST and stream are different processes", async () => {
		const driver = createMemoryDriver();
		// Two independent "invocations". The client's POSTs go to one; its stream
		// is held by the other. Nothing is shared but the bucket.
		const post = createInvocation(driver, "board", "fn-post");
		const stream = createInvocation(driver, "board", "fn-stream");

		// The REAL SSE client transport, with fetch and EventSource stubbed so the
		// new inline-reply path is what is actually under test.
		const originalFetch = globalThis.fetch;
		const originalEventSource = (globalThis as Record<string, unknown>).EventSource;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const message = JSON.parse(String(init?.body)) as ClientMessage;
			const replies = await post.transport.collectReplies("client1", message, () =>
				post.handler.whenIdle("client1"),
			);
			return new Response(JSON.stringify({ messages: replies }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		// The stream invocation never sends anything to this client in the test,
		// so an inert EventSource is enough to let subscribe() run.
		(globalThis as Record<string, unknown>).EventSource = class {
			onmessage: ((event: { data: string }) => void) | null = null;
			onerror: (() => void) | null = null;
			close(): void {}
		};

		const client = new SyncClient({
			clientId: "client1",
			token: "valid",
			transport: createSseClientTransport({
				eventUrl: "https://example.invalid/events",
				messageUrl: "https://example.invalid/messages",
				serverless: true,
			}),
		});

		try {
			await client.connect();
			await settle();
			// Without the inline replies this would still be "connecting": the
			// hello_ack was produced by a process that owns no stream for this client.
			expect(client.getState()).toBe("connected");

			await client.sync("cards");
			await settle();
			await client.bootstrap();
			await settle();
			expect(client.getState()).toBe("synced");

			client.insert("cards", "c1", { title: "Ship it", col: "todo" });
			await client.push();
			await settle();
			expect(client.getPendingCount()).toBe(0);

			// The write is durable in the bucket, put there by the POST invocation.
			expect((await post.storage.getRow("cards", "c1")).row).toMatchObject({ title: "Ship it" });

			// And the OTHER invocation — the one holding the stream — picks it up by
			// refreshing against the manifest, which is how a teammate's board updates.
			expect(await stream.storage.refresh()).toBe(true);
			expect((await stream.storage.getRow("cards", "c1")).row).toMatchObject({
				title: "Ship it",
			});

		} finally {
			globalThis.fetch = originalFetch;
			(globalThis as Record<string, unknown>).EventSource = originalEventSource;
		}
	});

	test("collectReplies returns nothing when serverless mode is off", async () => {
		// The single-process path must be untouched: replies stream as before, and
		// returning them here too would deliver each one twice.
		const driver = createMemoryDriver();
		const storage = createObjectStorage(
			{ driver, roomId: "single" },
			{ budget: new ProcessMemoryBudget() },
		);
		opened.push(storage);
		const transport = createSseServerTransport();
		const handler = new MessageHandler({ transport, serverId: "fn", db: {} });
		handler.setStorage(storage);
		handler.setAuth(async () => ({ userId: "u" }));

		const replies = await transport.collectReplies(
			"c1",
			{ type: "hello", clientId: "c1", token: "t", protocolVersion: 1 } as ClientMessage,
			() => handler.whenIdle("c1"),
		);
		expect(replies).toEqual([]);
	});
});
