import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { EphemeralManager } from "../../src/server/ephemeral/memory.ts";
import type { EphemeralAdapter, EphemeralBroadcast } from "../../src/server/ephemeral/types.ts";
import { createMockTransport } from "./helpers.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";

async function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function connectClient(
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
	userId: string,
): Promise<void> {
	transport.connectHandler!(clientId, new Request("https://sync"));
	transport.messageHandler!(clientId, {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId,
		token: userId,
	});
	await tick();
}

/**
 * Shared store plus an in-process bus — the same seam Redis fills, without the
 * round trips. Lets the fleet behaviour be tested for what it is: handler
 * fan-out across instances, not Redis.
 */
function createSharedEphemeral(maxEntries?: number): {
	forInstance(): EphemeralAdapter;
	published: EphemeralBroadcast[];
} {
	const store = new EphemeralManager(maxEntries);
	const listeners = new Set<(event: EphemeralBroadcast) => void>();
	const published: EphemeralBroadcast[] = [];

	return {
		published,
		forInstance(): EphemeralAdapter {
			return {
				set: (...args) => store.set(...args),
				get: (room, key) => store.get(room, key),
				getRoom: (room) => store.getRoom(room),
				remove: (room, key, userId) => store.remove(room, key, userId),
				removeClient: (clientId) => store.removeClient(clientId),
				cleanupExpired: () => store.cleanupExpired(),
				size: () => store.size(),
				// Shared state outlives one instance closing.
				destroy: () => {},
				publish(event) {
					published.push(event);
					for (const listener of listeners) listener(event);
				},
				subscribe(onEvent) {
					listeners.add(onEvent);
				},
			};
		},
	};
}

function setupInstance(adapter: EphemeralAdapter, serverId: string) {
	const transport = createMockTransport();
	const server = createServer({
		db: {},
		transport,
		serverId,
		ephemeral: { adapter },
	});
	server.auth(async (req) => ({
		userId: (req.headers.get("authorization") ?? "").replace("Bearer ", ""),
	}));
	server.query("posts", () => Promise.resolve([]), { tables: ["posts"] });
	server.room("org/:orgId", () => {});
	return { transport, server };
}

function ephemeralFor(transport: ReturnType<typeof createMockTransport>, clientId: string) {
	return transport.sentMessages.filter(
		(m) => m.clientId === clientId && m.message.type === "ephemeral",
	);
}

describe("ephemeral across a fleet", () => {
	test("presence reaches a client on another instance", async () => {
		const shared = createSharedEphemeral();
		const a = setupInstance(shared.forInstance(), "server-a");
		const b = setupInstance(shared.forInstance(), "server-b");

		await connectClient(a.transport, "alice", "u-alice");
		await connectClient(b.transport, "bob", "u-bob");
		for (const [inst, client] of [
			[a, "alice"],
			[b, "bob"],
		] as const) {
			inst.transport.messageHandler!(client, {
				type: "sync_declare",
				table: "posts",
				params: { orgId: "acme" },
			});
		}
		await tick();
		a.transport.sentMessages.length = 0;
		b.transport.sentMessages.length = 0;

		a.transport.messageHandler!("alice", {
			type: "ephemeral",
			key: "cursor",
			userId: "u-alice",
			data: { x: 42 },
		});
		await tick(30);

		const received = ephemeralFor(b.transport, "bob");
		expect(received.length).toBe(1);
		expect(received[0]!.message).toMatchObject({
			key: "cursor",
			userId: "u-alice",
			data: { x: 42 },
		});

		// The sender's own instance must not double-deliver from the bus echo.
		expect(ephemeralFor(a.transport, "alice").length).toBe(0);

		await a.server.close();
		await b.server.close();
	});

	test("an instance drops its own echo off the bus", async () => {
		const shared = createSharedEphemeral();
		const a = setupInstance(shared.forInstance(), "server-a");

		await connectClient(a.transport, "alice", "u-alice");
		await connectClient(a.transport, "amy", "u-amy");
		for (const client of ["alice", "amy"]) {
			a.transport.messageHandler!(client, {
				type: "sync_declare",
				table: "posts",
				params: { orgId: "acme" },
			});
		}
		await tick();
		a.transport.sentMessages.length = 0;

		a.transport.messageHandler!("alice", {
			type: "ephemeral",
			key: "cursor",
			userId: "u-alice",
			data: { x: 1 },
		});
		await tick(30);

		// Local fan-out delivered once; the echo carrying the same serverId is
		// dropped rather than delivered a second time.
		expect(shared.published.length).toBe(1);
		expect(ephemeralFor(a.transport, "amy").length).toBe(1);

		await a.server.close();
	});

	test("a client that joins late receives the room's existing presence", async () => {
		const shared = createSharedEphemeral();
		const a = setupInstance(shared.forInstance(), "server-a");
		const b = setupInstance(shared.forInstance(), "server-b");

		await connectClient(a.transport, "alice", "u-alice");
		a.transport.messageHandler!("alice", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme" },
		});
		await tick();

		a.transport.messageHandler!("alice", {
			type: "ephemeral",
			key: "cursor",
			userId: "u-alice",
			data: { x: 7 },
		});
		await tick(30);

		// Bob arrives after Alice has already moved. Without a snapshot he sees
		// nothing until she moves again.
		await connectClient(b.transport, "bob", "u-bob");
		b.transport.sentMessages.length = 0;
		b.transport.messageHandler!("bob", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme" },
		});
		await tick(30);

		const snapshot = ephemeralFor(b.transport, "bob");
		expect(snapshot.length).toBe(1);
		expect(snapshot[0]!.message).toMatchObject({
			key: "cursor",
			userId: "u-alice",
			data: { x: 7 },
		});

		await a.server.close();
		await b.server.close();
	});

	test("the snapshot excludes the joiner's own entries", async () => {
		const shared = createSharedEphemeral();
		const a = setupInstance(shared.forInstance(), "server-a");

		await connectClient(a.transport, "alice", "u-alice");
		a.transport.messageHandler!("alice", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme" },
		});
		await tick();
		a.transport.messageHandler!("alice", {
			type: "ephemeral",
			key: "cursor",
			userId: "u-alice",
			data: { x: 1 },
		});
		await tick(30);
		a.transport.sentMessages.length = 0;

		// Re-declaring must not echo Alice's own cursor back at her.
		a.transport.messageHandler!("alice", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme" },
		});
		await tick(30);

		expect(ephemeralFor(a.transport, "alice").length).toBe(0);

		await a.server.close();
	});

	test("disconnecting clears the sender's entries from shared state", async () => {
		const shared = createSharedEphemeral();
		const a = setupInstance(shared.forInstance(), "server-a");
		const b = setupInstance(shared.forInstance(), "server-b");

		await connectClient(a.transport, "alice", "u-alice");
		a.transport.messageHandler!("alice", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme" },
		});
		await tick();
		a.transport.messageHandler!("alice", {
			type: "ephemeral",
			key: "cursor",
			userId: "u-alice",
			data: { x: 1 },
		});
		await tick(30);

		a.transport.disconnectHandler!("alice");
		await tick(20);

		// Bob joins on the other instance and should find an empty room.
		await connectClient(b.transport, "bob", "u-bob");
		b.transport.sentMessages.length = 0;
		b.transport.messageHandler!("bob", {
			type: "sync_declare",
			table: "posts",
			params: { orgId: "acme" },
		});
		await tick(30);

		expect(ephemeralFor(b.transport, "bob").length).toBe(0);

		await a.server.close();
		await b.server.close();
	});
});
