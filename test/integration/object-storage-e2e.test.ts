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
import { createWsServerTransport } from "../../src/transport/ws.ts";
import type { WebSocketLike } from "../../src/transport/ws.ts";
import type { ClientMessage, ClientTransport, ServerMessage } from "../../src/core/types.ts";

/**
 * The object-storage adapter driving a real sync server, not just satisfying
 * the `StorageAdapter` interface in isolation.
 *
 * The second test is the one that matters: a server restart with nothing but an
 * object store behind it. No Postgres, no SQLite, and the row survives — which
 * is the entire point of the backend.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The server's op pipeline is several awaits deep (reserve, prefetch, conflict,
 * apply, flush), so a single macrotask is not enough to let a pushed op settle
 * before a test closes the storage under it.
 */
const settle = async () => {
	for (let i = 0; i < 12; i++) await tick();
};

const opened: ObjectStorage[] = [];

afterAll(async () => {
	await Promise.allSettled(opened.map((s) => s.close()));
});

function openStorage(driver: ObjectDriver, roomId: string): ObjectStorage {
	const storage = createObjectStorage({ driver, roomId }, { budget: new ProcessMemoryBudget() });
	opened.push(storage);
	return storage;
}

/** Pipes client and server message streams directly into each other. */
function createLoopback(clientId: string) {
	const serverWs = createWsServerTransport();
	let clientHandler: ((message: ServerMessage) => void) | null = null;
	const received: ServerMessage[] = [];

	const mockWs: WebSocketLike = {
		send(data: string): void {
			const message = JSON.parse(data) as ServerMessage;
			received.push(message);
			clientHandler?.(message);
		},
		close(): void {},
	};

	const client: ClientTransport = {
		async send(message: ClientMessage): Promise<void> {
			serverWs.handleMessage(clientId, JSON.stringify(message));
		},
		subscribe(handler: (message: ServerMessage) => void): void {
			clientHandler = handler;
		},
		async close(): Promise<void> {},
	};

	return { client, serverWs, mockWs, received };
}

/** A server whose entire durable state is `storage`. */
function createServer(storage: ObjectStorage, serverId: string) {
	const { client: clientTransport, serverWs, mockWs, received } = createLoopback("client1");

	const handler = new MessageHandler({ transport: serverWs, serverId, db: {} });
	handler.setStorage(storage);
	handler.setAuth(async () => ({ userId: "user1" }));
	handler.setQuery("posts", {
		name: "posts",
		// Reads straight out of the adapter, so a bootstrap after a restart is
		// answered entirely from what the object store gave back.
		callback: async () => (await storage.getRows("posts")).rows,
		tableDependencies: new Set(["posts"]),
		options: {
			tables: ["posts"],
			conflict: "lww",
			mutate: async (op) => {
				if (op.type === "delete") {
					await storage.putRow("posts", op.rowId, null, {}, op.hlc);
				} else {
					await storage.putRow("posts", op.rowId, { ...op.payload, id: op.rowId }, {}, op.hlc);
				}
			},
		},
	});

	return { clientTransport, serverWs, mockWs, received };
}

describe("object storage end-to-end", () => {
	test("full lifecycle: connect, sync, insert, ack — with no database", async () => {
		const storage = openStorage(createMemoryDriver(), "e2e-lifecycle");
		const { clientTransport, serverWs, mockWs } = createServer(storage, "obj-e2e-1");

		const errors: { reason: string }[] = [];
		const client = new SyncClient({
			clientId: "client1",
			transport: clientTransport,
			token: "valid",
			onError: (e) => errors.push(e),
		});

		serverWs.handleOpen("client1", mockWs);
		await client.connect();
		await tick();
		expect(client.getState()).toBe("connected");

		await client.sync("posts");
		await tick();
		await client.bootstrap();
		await tick();
		expect(client.getState()).toBe("synced");

		client.insert("posts", "row-1", { title: "hello" });
		expect(client.getPendingCount()).toBe(1);

		await client.push();
		await settle();

		expect(errors).toEqual([]);
		expect(client.getPendingCount()).toBe(0);
		expect((await storage.getRow("posts", "row-1")).row).toMatchObject({ title: "hello" });
		expect(client.getRow("posts", "row-1")).toMatchObject({ title: "hello" });
	});

	test("a restart with only an object store behind it keeps the data", async () => {
		// One bucket, two server processes. Nothing else persists anything.
		const driver = createMemoryDriver();

		{
			const storage = openStorage(driver, "e2e-restart");
			const { clientTransport, serverWs, mockWs } = createServer(storage, "obj-e2e-before");
			const client = new SyncClient({
				clientId: "client1",
				transport: clientTransport,
				token: "valid",
			});

			serverWs.handleOpen("client1", mockWs);
			await client.connect();
			await tick();
			await client.sync("posts");
			await tick();
			await client.bootstrap();
			await tick();

			client.insert("posts", "row-1", { title: "survives" });
			await client.push();
			await settle();
			expect((await storage.getRow("posts", "row-1")).row).toMatchObject({
				title: "survives",
			});

			// A deploy: drain, commit, release the lease.
			await storage.close();
		}

		// A fresh process, a fresh adapter, the same bucket.
		const restarted = openStorage(driver, "e2e-restart");
		const { clientTransport, serverWs, mockWs, received } = createServer(restarted, "obj-e2e-after");
		const client = new SyncClient({
			clientId: "client1",
			transport: clientTransport,
			token: "valid",
		});

		serverWs.handleOpen("client1", mockWs);
		await client.connect();
		await tick();
		await client.sync("posts");
		await tick();
		await client.bootstrap();
		await settle();

		// The restarted server answered a fresh client's bootstrap out of the
		// object store alone — no database, no carried-over process state.
		const snapshot = received.find(
			(m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot",
		);
		expect(snapshot?.rows).toHaveLength(1);
		expect(snapshot?.rows[0]).toMatchObject({ title: "survives" });
		// And the row is addressable by id in the restarted adapter, so a later
		// conflict resolution reads the state the previous process committed.
		expect((await restarted.getRow("posts", "row-1")).row).toMatchObject({
			title: "survives",
		});
	});

	test("a replayed op is deduped across a restart", async () => {
		// `reserveOp` is what makes client resend safe, and the reserved set has to
		// survive the restart or a reconnecting client double-applies.
		const driver = createMemoryDriver();
		const first = openStorage(driver, "e2e-dedupe");
		await first.init();
		expect(await first.reserveOp("op-1")).toBe(true);
		await first.flush();
		await first.close();

		const second = openStorage(driver, "e2e-dedupe");
		await second.init();
		expect(await second.reserveOp("op-1")).toBe(false);
	});
});
