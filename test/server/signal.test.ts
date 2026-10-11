import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { EphemeralManager } from "../../src/server/ephemeral/memory.ts";
import type { EphemeralAdapter, EphemeralBroadcast } from "../../src/server/ephemeral/types.ts";
import { createMockTransport } from "./helpers.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";

async function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Shared store plus an in-process bus, as in ephemeral-fleet.test.ts. */
function createSharedBus() {
	const store = new EphemeralManager();
	const listeners = new Set<(event: EphemeralBroadcast) => void>();
	const published: EphemeralBroadcast[] = [];
	return {
		published,
		forInstance(): EphemeralAdapter {
			return {
				set: (...args) => store.set(...args),
				get: (room, key) => store.get(room, key),
				getRoom: (room) => store.getRoom(room),
				remove: (room, key, clientId) => store.remove(room, key, clientId),
				removeClient: (clientId) => store.removeClient(clientId),
				cleanupExpired: () => store.cleanupExpired(),
				size: () => store.size(),
				destroy: () => {},
				publish(event) {
					// Through JSON, as every real bus carries it.
					const wire = JSON.parse(JSON.stringify(event)) as EphemeralBroadcast;
					published.push(wire);
					for (const listener of listeners) listener(wire);
				},
				subscribe(onEvent) {
					listeners.add(onEvent);
				},
			};
		},
	};
}

function setupInstance(serverId: string, adapter?: EphemeralAdapter) {
	const transport = createMockTransport();
	const server = createServer({
		db: {},
		transport,
		serverId,
		...(adapter ? { ephemeral: { adapter } } : {}),
	});
	server.auth(async (req) => ({
		userId: (req.headers.get("authorization") ?? "").replace("Bearer ", ""),
	}));
	server.query("posts", () => Promise.resolve([]), { tables: ["posts"] });
	server.room("org/:orgId", () => {});
	return { transport, server };
}

type Instance = ReturnType<typeof setupInstance>;

async function join(inst: Instance, clientId: string, orgId: string | null): Promise<void> {
	inst.transport.connectHandler!(clientId, new Request("https://sync"));
	inst.transport.messageHandler!(clientId, {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId,
		token: `u-${clientId}`,
	});
	await tick();
	if (orgId !== null) {
		inst.transport.messageHandler!(clientId, {
			type: "sync_declare",
			table: "posts",
			params: { orgId },
		});
		await tick();
	}
}

function signalsFor(inst: Instance, clientId: string) {
	return inst.transport.sentMessages
		.filter((m) => m.clientId === clientId && m.message.type === "signal")
		.map((m) => m.message);
}

describe("signal", () => {
	test("reaches one peer in the same room, stamped with the sender's session", async () => {
		const store = new EphemeralManager();
		const a = setupInstance("server-a", store);
		await join(a, "alice", "acme");
		await join(a, "bob", "acme");
		await join(a, "carol", "acme");

		a.transport.messageHandler!("alice", {
			type: "signal",
			to: "bob",
			data: { t: "desc", sdp: "v=0" },
		});
		await tick();

		expect(signalsFor(a, "bob")).toEqual([
			{ type: "signal", from: "alice", userId: "u-alice", data: { t: "desc", sdp: "v=0" } },
		]);
		// Targeted: the rest of the room sees nothing, and nothing is stored.
		expect(signalsFor(a, "carol")).toEqual([]);
		expect(store.size()).toBe(0);

		await a.server.close();
	});

	test("is dropped when sender and recipient share no room", async () => {
		const a = setupInstance("server-a");
		await join(a, "alice", "acme");
		await join(a, "mallory", "evil");
		await join(a, "nobody", null);

		a.transport.messageHandler!("alice", { type: "signal", to: "mallory", data: { x: 1 } });
		a.transport.messageHandler!("alice", { type: "signal", to: "nobody", data: { x: 1 } });
		a.transport.messageHandler!("nobody", { type: "signal", to: "alice", data: { x: 1 } });
		await tick();

		expect(signalsFor(a, "mallory")).toEqual([]);
		expect(signalsFor(a, "nobody")).toEqual([]);
		expect(signalsFor(a, "alice")).toEqual([]);

		await a.server.close();
	});

	test("a sender with a room-less subscription cannot reach a client inside a room", async () => {
		const a = setupInstance("server-a");
		await join(a, "bob", "acme");
		// Same query, no room param: the subscription resolves to no room.
		a.transport.connectHandler!("mallory", new Request("https://sync"));
		a.transport.messageHandler!("mallory", {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			clientId: "mallory",
			token: "u-mallory",
		});
		await tick();
		a.transport.messageHandler!("mallory", { type: "sync_declare", table: "posts", params: {} });
		await tick();

		a.transport.messageHandler!("mallory", { type: "signal", to: "bob", data: { t: "hello" } });
		await tick();

		expect(signalsFor(a, "bob")).toEqual([]);
		await a.server.close();
	});

	test("an ephemeral event from a room-less subscription reaches only room-less subscribers", async () => {
		const a = setupInstance("server-a");
		await join(a, "bob", "acme");
		for (const id of ["mallory", "carol"]) {
			a.transport.connectHandler!(id, new Request("https://sync"));
			a.transport.messageHandler!(id, {
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				clientId: id,
				token: `u-${id}`,
			});
			await tick();
			a.transport.messageHandler!(id, { type: "sync_declare", table: "posts", params: {} });
			await tick();
		}
		a.transport.sentMessages.length = 0;

		a.transport.messageHandler!("mallory", {
			type: "ephemeral",
			key: "cursor",
			userId: "u-mallory",
			data: { x: 1 },
		});
		await tick();

		const ephemeralTo = (id: string) =>
			a.transport.sentMessages.filter((m) => m.clientId === id && m.message.type === "ephemeral");
		// Not into the room it never joined...
		expect(ephemeralTo("bob")).toEqual([]);
		// ...while apps that use no rooms keep their broadcast.
		expect(ephemeralTo("carol")).toHaveLength(1);
		await a.server.close();
	});

	test("drops an oversized frame", async () => {
		const a = setupInstance("server-a");
		await join(a, "alice", "acme");
		await join(a, "bob", "acme");

		a.transport.messageHandler!("alice", {
			type: "signal",
			to: "bob",
			data: { sdp: "x".repeat(5000) },
		});
		await tick();

		expect(signalsFor(a, "bob")).toEqual([]);
		await a.server.close();
	});

	test("crosses instances over the ephemeral bus", async () => {
		const bus = createSharedBus();
		const a = setupInstance("server-a", bus.forInstance());
		const b = setupInstance("server-b", bus.forInstance());
		await join(a, "alice", "acme");
		await join(b, "bob", "acme");
		await join(b, "eve", "other");

		a.transport.messageHandler!("alice", {
			type: "signal",
			to: "bob",
			data: { t: "ice", c: "cand" },
		});
		a.transport.messageHandler!("alice", {
			type: "signal",
			to: "eve",
			data: { t: "ice", c: "cand" },
		});
		await tick(30);

		expect(signalsFor(b, "bob")).toEqual([
			{ type: "signal", from: "alice", userId: "u-alice", data: { t: "ice", c: "cand" } },
		]);
		// The recipient's instance enforces the shared room too.
		expect(signalsFor(b, "eve")).toEqual([]);
		// A signal is never replayed as presence.
		expect(b.transport.sentMessages.some((m) => m.message.type === "ephemeral")).toBe(false);

		await a.server.close();
		await b.server.close();
	});

	test("a local recipient is not also published to the bus", async () => {
		const bus = createSharedBus();
		const a = setupInstance("server-a", bus.forInstance());
		await join(a, "alice", "acme");
		await join(a, "bob", "acme");

		a.transport.messageHandler!("alice", { type: "signal", to: "bob", data: { x: 1 } });
		await tick(30);

		expect(signalsFor(a, "bob").length).toBe(1);
		expect(bus.published.filter((e) => e.kind === "signal")).toEqual([]);

		await a.server.close();
	});
});

describe("ice_request", () => {
	function iceRepliesFor(inst: Instance, clientId: string) {
		return inst.transport.sentMessages
			.filter((m) => m.clientId === clientId && m.message.type === "ice_servers")
			.map((m) => m.message);
	}

	test("answers with the provider's servers, called with the session's auth", async () => {
		const a = setupInstance("server-a");
		const seen: unknown[] = [];
		a.server.iceServers(({ auth }) => {
			seen.push(auth);
			return {
				iceServers: [{ urls: "turn:turn.example.com:3478", username: "u", credential: "c" }],
				ttlSeconds: 600,
			};
		});
		await join(a, "alice", "acme");

		const before = Date.now();
		a.transport.messageHandler!("alice", { type: "ice_request" });
		await tick();

		const [reply] = iceRepliesFor(a, "alice") as Array<{ iceServers: unknown; expiresAt: number }>;
		expect(reply!.iceServers).toEqual([
			{ urls: "turn:turn.example.com:3478", username: "u", credential: "c" },
		]);
		expect(reply!.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
		expect(seen).toEqual([{ userId: "u-alice" }]);
		await a.server.close();
	});

	test("answers with an empty list when no provider is set, or the provider fails", async () => {
		const a = setupInstance("server-a");
		await join(a, "alice", "acme");
		a.transport.messageHandler!("alice", { type: "ice_request" });
		await tick();

		a.server.iceServers(() => {
			throw new Error("TURN API down");
		});
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		a.transport.messageHandler!("alice", { type: "ice_request" });
		await tick();
		console.error = original;

		expect(iceRepliesFor(a, "alice")).toEqual([
			{ type: "ice_servers", iceServers: [], expiresAt: null },
			{ type: "ice_servers", iceServers: [], expiresAt: null },
		]);
		expect(errors).toHaveLength(1);
		await a.server.close();
	});
});
