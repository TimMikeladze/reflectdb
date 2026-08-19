import { describe, expect, test } from "bun:test";
import { createPresenceService } from "../../services/presence/service.ts";
import { createMemoryEphemeral } from "../../src/server/ephemeral/memory.ts";
import type { EphemeralAdapter } from "../../src/server/ephemeral/types.ts";
import { PRESENCE_PROTOCOL_VERSION } from "../../services/presence/protocol.ts";
import { createFakeConnection, createFakeRedis, settle } from "./helpers.ts";

const SEED = {
	"key-live": { projectId: "proj-1" },
	"key-tiny": { projectId: "proj-2", maxConnections: 1, maxMessagesPerSecond: 2 },
};

async function setup(
	options: { store?: EphemeralAdapter; serverId?: string; redis?: ReturnType<typeof createFakeRedis> } = {},
) {
	const redis = options.redis ?? createFakeRedis();
	const service = createPresenceService({
		client: redis.client,
		subscriber: redis.subscriberFor(),
		store: options.store ?? createMemoryEphemeral(),
		serverId: options.serverId ?? "server-a",
		seed: SEED,
		sweepIntervalMs: 0,
	});
	await service.start();
	return { service, redis };
}

function hello(apiKey: string, room: string, identity?: Record<string, unknown>): string {
	return JSON.stringify({
		type: "hello",
		protocolVersion: PRESENCE_PROTOCOL_VERSION,
		apiKey,
		room,
		identity,
	});
}

async function connect(
	service: Awaited<ReturnType<typeof setup>>["service"],
	apiKey: string,
	room: string,
	identity?: Record<string, unknown>,
) {
	const connection = createFakeConnection();
	const clientId = crypto.randomUUID();
	service.open(clientId, connection);
	await service.handle(clientId, hello(apiKey, room, identity));
	return { connection, clientId };
}

describe("presence service", () => {
	test("hello returns welcome and a snapshot", async () => {
		const { service } = await setup();
		const { connection } = await connect(service, "key-live", "board-1");

		const welcome = connection.framesOfType("welcome")[0];
		expect(welcome).toBeDefined();
		expect(welcome!.protocolVersion).toBe(PRESENCE_PROTOCOL_VERSION);
		expect(welcome!.room).toBe("board-1");

		// An empty room still gets a snapshot — the client should not have to
		// distinguish "no peers yet" from "snapshot never arrived".
		const snapshot = connection.framesOfType("snapshot")[0];
		expect(snapshot).toBeDefined();
		expect(snapshot!.peers).toEqual([]);

		await service.shutdown();
	});

	test("an unknown API key is rejected and the socket closed", async () => {
		const { service } = await setup();
		const { connection } = await connect(service, "key-bogus", "board-1");

		const error = connection.framesOfType("error")[0];
		expect(error?.code).toBe("unauthorized");
		expect(error?.fatal).toBe(true);
		expect(connection.closed).toBe(true);

		await service.shutdown();
	});

	test("a protocol version mismatch is refused rather than guessed at", async () => {
		const { service } = await setup();
		const connection = createFakeConnection();
		const clientId = crypto.randomUUID();
		service.open(clientId, connection);
		await service.handle(
			clientId,
			JSON.stringify({
				type: "hello",
				protocolVersion: PRESENCE_PROTOCOL_VERSION + 1,
				apiKey: "key-live",
				room: "board-1",
			}),
		);

		expect(connection.framesOfType("error")[0]?.code).toBe("protocol_version");
		expect(connection.closed).toBe(true);

		await service.shutdown();
	});

	test("a frame before hello is refused", async () => {
		const { service } = await setup();
		const connection = createFakeConnection();
		const clientId = crypto.randomUUID();
		service.open(clientId, connection);
		await service.handle(clientId, JSON.stringify({ type: "publish", channel: "c", data: {} }));

		expect(connection.framesOfType("error")[0]?.code).toBe("unauthorized");
		expect(connection.closed).toBe(true);

		await service.shutdown();
	});

	test("a publish sent before hello resolves is not mistaken for a bad first frame", async () => {
		// Every existing test awaits `hello` before sending anything else, which
		// is not how a socket behaves: a client that publishes immediately after
		// connecting puts both frames on the wire in one go. `hello` resolves an
		// API key and acquires a connection slot before it marks the session
		// joined, so without per-connection ordering the publish arrives mid-flight
		// and gets refused as "first frame must be hello" — fatally. The bundled
		// client hits this on every reconnect, replaying its outbox.
		const { service } = await setup();
		const connection = createFakeConnection();
		const clientId = crypto.randomUUID();
		service.open(clientId, connection);

		const both = Promise.all([
			service.handle(clientId, hello("key-live", "board-1")),
			service.handle(
				clientId,
				JSON.stringify({ type: "publish", channel: "cursor", data: { x: 1, y: 2 } }),
			),
		]);
		await both;
		await settle();

		expect(connection.framesOfType("error")).toEqual([]);
		expect(connection.closed).toBe(false);
		expect(connection.framesOfType("welcome").length).toBe(1);

		// The publish landed rather than being dropped on the floor: a peer
		// joining now sees it in the snapshot.
		const late = await connect(service, "key-live", "board-1");
		expect(late.connection.framesOfType("snapshot")[0]?.peers).toMatchObject([
			{ clientId, channel: "cursor", data: { x: 1, y: 2 } },
		]);

		await service.shutdown();
	});

	test("publish reaches peers and never echoes to the sender", async () => {
		const { service } = await setup();
		const alice = await connect(service, "key-live", "board-1", { name: "Alice" });
		const bob = await connect(service, "key-live", "board-1", { name: "Bob" });
		bob.connection.frames.length = 0;

		await service.handle(
			alice.clientId,
			JSON.stringify({ type: "publish", channel: "cursor", data: { x: 4, y: 9 } }),
		);

		const received = bob.connection.framesOfType("presence");
		expect(received.length).toBe(1);
		expect(received[0]).toMatchObject({
			clientId: alice.clientId,
			channel: "cursor",
			data: { x: 4, y: 9 },
			identity: { name: "Alice" },
		});
		expect(alice.connection.framesOfType("presence").length).toBe(0);

		await service.shutdown();
	});

	test("a room in another project never receives the frame", async () => {
		const { service } = await setup();
		const inside = await connect(service, "key-live", "board-1");
		const outside = await connect(service, "key-tiny", "board-1");
		outside.connection.frames.length = 0;

		await service.handle(
			inside.clientId,
			JSON.stringify({ type: "publish", channel: "cursor", data: { x: 1 } }),
		);

		// Same room name, different project — namespacing must keep them apart.
		expect(outside.connection.framesOfType("presence").length).toBe(0);

		await service.shutdown();
	});

	test("a joiner sees peers who arrived before it", async () => {
		const { service } = await setup();
		const alice = await connect(service, "key-live", "board-1", { name: "Alice" });
		await service.handle(
			alice.clientId,
			JSON.stringify({ type: "publish", channel: "cursor", data: { x: 7 } }),
		);

		const bob = await connect(service, "key-live", "board-1");
		const snapshot = bob.connection.framesOfType("snapshot")[0];
		// A snapshot peer must be shaped exactly like a live presence frame —
		// the identity split out, no internal storage key leaking through.
		expect(snapshot!.peers).toEqual([
			{
				clientId: alice.clientId,
				channel: "cursor",
				data: { x: 7 },
				identity: { name: "Alice" },
			},
		]);

		await service.shutdown();
	});

	test("disconnecting tells peers at once instead of waiting for a TTL", async () => {
		const { service } = await setup();
		const alice = await connect(service, "key-live", "board-1");
		const bob = await connect(service, "key-live", "board-1");
		await service.handle(
			alice.clientId,
			JSON.stringify({ type: "publish", channel: "cursor", data: { x: 1 } }),
		);
		bob.connection.frames.length = 0;

		await service.close(alice.clientId);

		const leave = bob.connection.framesOfType("leave");
		expect(leave.length).toBe(1);
		expect(leave[0]!.clientId).toBe(alice.clientId);
		expect(leave[0]!.channel).toBeUndefined();

		await service.shutdown();
	});

	test("clear drops one channel and leaves the connection joined", async () => {
		const { service } = await setup();
		const alice = await connect(service, "key-live", "board-1");
		const bob = await connect(service, "key-live", "board-1");
		await service.handle(
			alice.clientId,
			JSON.stringify({ type: "publish", channel: "cursor", data: { x: 1 } }),
		);
		bob.connection.frames.length = 0;

		await service.handle(alice.clientId, JSON.stringify({ type: "clear", channel: "cursor" }));

		const leave = bob.connection.framesOfType("leave");
		expect(leave.length).toBe(1);
		expect(leave[0]!.channel).toBe("cursor");

		// Still joined: a further publish reaches the room.
		await service.handle(
			alice.clientId,
			JSON.stringify({ type: "publish", channel: "typing", data: { on: true } }),
		);
		expect(bob.connection.framesOfType("presence").length).toBe(1);

		await service.shutdown();
	});

	test("publishing past the per-second ceiling is refused without dropping the socket", async () => {
		const { service } = await setup();
		const sender = await connect(service, "key-tiny", "room");
		sender.connection.frames.length = 0;

		for (let i = 0; i < 5; i++) {
			await service.handle(
				sender.clientId,
				JSON.stringify({ type: "publish", channel: "cursor", data: { i } }),
			);
		}

		// maxMessagesPerSecond is 2 for this project.
		const errors = sender.connection.framesOfType("error");
		expect(errors.length).toBe(3);
		expect(errors[0]!.code).toBe("rate_limited");
		expect(errors[0]!.fatal).toBe(false);
		expect(sender.connection.closed).toBe(false);

		await service.shutdown();
	});

	test("a project at its connection cap refuses the next connection", async () => {
		const { service } = await setup();
		const first = await connect(service, "key-tiny", "room");
		expect(first.connection.framesOfType("welcome").length).toBe(1);

		const second = await connect(service, "key-tiny", "room");
		expect(second.connection.framesOfType("error")[0]?.code).toBe("project_connection_limit");
		expect(second.connection.closed).toBe(true);

		// Freeing the slot lets the next one in — the counter must not leak.
		await service.close(first.clientId);
		const third = await connect(service, "key-tiny", "room");
		expect(third.connection.framesOfType("welcome").length).toBe(1);

		await service.shutdown();
	});

	test("a malformed frame after hello is reported without closing", async () => {
		const { service } = await setup();
		const client = await connect(service, "key-live", "board-1");
		client.connection.frames.length = 0;

		await service.handle(client.clientId, "not json at all");

		expect(client.connection.framesOfType("error")[0]?.code).toBe("bad_frame");
		expect(client.connection.closed).toBe(false);

		await service.shutdown();
	});

	test("ping is answered", async () => {
		const { service } = await setup();
		const client = await connect(service, "key-live", "board-1");
		await service.handle(client.clientId, JSON.stringify({ type: "ping" }));
		expect(client.connection.framesOfType("pong").length).toBe(1);
		await service.shutdown();
	});

	test("presence crosses instances over the bus", async () => {
		// One shared store and one shared bus, two services — the fleet case.
		const redis = createFakeRedis();
		const store = createMemoryEphemeral();
		const a = await setup({ redis, store, serverId: "server-a" });
		const b = await setup({ redis, store, serverId: "server-b" });

		const alice = await connect(a.service, "key-live", "board-1", { name: "Alice" });
		const bob = await connect(b.service, "key-live", "board-1");
		bob.connection.frames.length = 0;

		await a.service.handle(
			alice.clientId,
			JSON.stringify({ type: "publish", channel: "cursor", data: { x: 3 } }),
		);
		await settle();

		const received = bob.connection.framesOfType("presence");
		expect(received.length).toBe(1);
		expect(received[0]).toMatchObject({ clientId: alice.clientId, data: { x: 3 } });

		// And the sender's own instance must not double-deliver its echo.
		expect(alice.connection.framesOfType("presence").length).toBe(0);

		await a.service.shutdown();
		await b.service.shutdown();
	});

	test("a disconnect on one instance clears the cursor on another", async () => {
		const redis = createFakeRedis();
		const store = createMemoryEphemeral();
		const a = await setup({ redis, store, serverId: "server-a" });
		const b = await setup({ redis, store, serverId: "server-b" });

		const alice = await connect(a.service, "key-live", "board-1");
		const bob = await connect(b.service, "key-live", "board-1");
		await a.service.handle(
			alice.clientId,
			JSON.stringify({ type: "publish", channel: "cursor", data: { x: 1 } }),
		);
		await settle();
		bob.connection.frames.length = 0;

		await a.service.close(alice.clientId);
		await settle();

		expect(bob.connection.framesOfType("leave").length).toBe(1);

		await a.service.shutdown();
		await b.service.shutdown();
	});

	test("metrics report what the instance is holding", async () => {
		const { service } = await setup();
		const client = await connect(service, "key-live", "board-1");
		await service.handle(
			client.clientId,
			JSON.stringify({ type: "publish", channel: "cursor", data: { x: 1 } }),
		);

		const metrics = service.metrics();
		expect(metrics.connections).toBe(1);
		expect(metrics.rooms).toBe(1);
		expect(metrics.messagesPublished).toBe(1);
		expect(metrics.serverId).toBe("server-a");

		await service.shutdown();
	});

	test("shutdown releases every connection slot it held", async () => {
		const { service, redis } = await setup();
		await connect(service, "key-live", "board-1");
		await connect(service, "key-live", "board-1");
		expect(await service.registry.connectionCount("proj-1")).toBe(2);

		// A rolling deploy must not leave a project counted against its cap by a
		// machine that no longer exists.
		await service.shutdown();
		expect(Number(redis.strings.get("presence:conn:proj-1"))).toBe(0);
	});
});
