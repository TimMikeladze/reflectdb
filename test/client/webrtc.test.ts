import { afterEach, describe, expect, test } from "bun:test";
import { RTCPeerConnection as PolyfillPeerConnection } from "node-datachannel/polyfill";
import { SyncClient } from "../../src/client/sync-client.ts";
import { createPeerMesh, type PeerMesh } from "../../src/client/webrtc.ts";
import { createServer } from "../../src/server/server.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type {
	ClientMessage,
	ClientTransport,
	EphemeralEvent,
	ServerMessage,
	ServerTransport,
} from "../../src/core/types.ts";

/**
 * node-datachannel 0.33's polyfill never fires `negotiationneeded` (its guard
 * checks a flag initialised to false against null). Browsers fire it when the
 * first data channel is created; this restores that one event.
 */
class SpecPeerConnection extends (PolyfillPeerConnection as unknown as typeof globalThis.RTCPeerConnection) {
	static instances: SpecPeerConnection[] = [];
	#announced = false;
	#forced: RTCPeerConnectionState | null = null;
	constructor(config?: RTCConfiguration) {
		super(config);
		SpecPeerConnection.instances.push(this);
	}
	override get connectionState(): RTCPeerConnectionState {
		return this.#forced ?? super.connectionState;
	}
	/** Simulate ICE losing the peer (a closed tab, a dropped network) without a clean close. */
	loseConnection(state: RTCPeerConnectionState): void {
		this.#forced = state;
		this.dispatchEvent(new Event("connectionstatechange"));
	}
	override createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
		const channel = super.createDataChannel(label, init);
		if (!this.#announced) {
			this.#announced = true;
			queueMicrotask(() => this.dispatchEvent(new Event("negotiationneeded")));
		}
		return channel;
	}
}

/**
 * Real WebRTC: node-datachannel's polyfill opens actual data channels over
 * loopback, so negotiation, channel setup, and frame delivery are exercised for
 * what they are. Media is browser-only and is verified there.
 */

async function waitFor(predicate: () => boolean, ms = 8000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** One server, any number of clients, every frame through JSON like a socket. */
function createRoom() {
	const clientHandlers = new Map<string, (message: ServerMessage) => void>();
	/** Ephemeral frames the server received, per sender. */
	const serverFrames: Array<{ clientId: string; message: ClientMessage }> = [];
	let onMessage: ((clientId: string, message: ClientMessage) => void) | null = null;
	let onConnect: ((clientId: string, req: Request) => void) | null = null;

	const transport: ServerTransport = {
		async send(clientId, message) {
			clientHandlers.get(clientId)?.(JSON.parse(JSON.stringify(message)));
		},
		async broadcast() {},
		onMessage(handler) {
			onMessage = handler;
		},
		onConnect(handler) {
			onConnect = handler;
		},
		onDisconnect() {},
		async close() {},
	};
	const server = createServer({ db: {}, transport, serverId: "server" });
	server.auth(async (req) => ({
		userId: (req.headers.get("authorization") ?? "").replace("Bearer ", ""),
	}));
	server.query("posts", () => Promise.resolve([]), { tables: ["posts"] });
	server.room("org/:orgId", () => {});

	const clients: SyncClient[] = [];
	const meshes: PeerMesh[] = [];

	/** `clientId` is the server's id for the connection; `configuredId` what the client was built with. */
	async function join(
		clientId: string,
		orgId = "acme",
		configuredId = clientId,
	): Promise<SyncClient> {
		const clientTransport: ClientTransport = {
			async send(message) {
				const wire = JSON.parse(JSON.stringify(message)) as ClientMessage;
				if (wire.type === "ephemeral") serverFrames.push({ clientId, message: wire });
				onMessage!(clientId, wire);
			},
			subscribe(handler) {
				clientHandlers.set(clientId, handler);
			},
			async close() {},
		};
		const client = new SyncClient({
			clientId: configuredId,
			transport: clientTransport,
			token: `u-${clientId}`,
		});
		onConnect!(clientId, new Request("https://sync"));
		await client.connect();
		await client.sync("posts", { orgId });
		await new Promise((r) => setTimeout(r, 20));
		clients.push(client);
		return client;
	}

	function mesh(client: SyncClient, config: Parameters<typeof createPeerMesh>[1] = {}): PeerMesh {
		const m = createPeerMesh(client, {
			iceServers: [],
			RTCPeerConnection: SpecPeerConnection,
			...config,
		});
		meshes.push(m);
		return m;
	}

	function framesFrom(clientId: string, key: string) {
		return serverFrames.filter(
			(f) => f.clientId === clientId && f.message.type === "ephemeral" && f.message.key === key,
		);
	}

	async function close(): Promise<void> {
		for (const m of meshes) m.destroy();
		await new Promise((r) => setTimeout(r, 50));
		await server.close();
	}

	return { join, mesh, framesFrom, close, PROTOCOL_VERSION };
}

let room: ReturnType<typeof createRoom> | null = null;
afterEach(async () => {
	await room?.close();
	room = null;
});

function connected(mesh: PeerMesh, peer: string): boolean {
	return mesh.getSnapshot().peers.some((p) => p.clientId === peer && p.state === "connected");
}

describe("peer mesh", () => {
	test("two clients in a room connect peer-to-peer and exchange frames directly", async () => {
		room = createRoom();
		const alice = await room.join("alice");
		const bob = await room.join("bob");
		const meshA = room.mesh(alice);
		const meshB = room.mesh(bob);

		await waitFor(() => connected(meshA, "bob") && connected(meshB, "alice"));
		expect(meshB.getSnapshot().peers).toEqual([
			{ clientId: "alice", userId: "u-alice", state: "connected", inCall: false },
		]);

		const received: EphemeralEvent[] = [];
		bob.subscribeEphemeral("cursor", (e) => received.push(e));
		await alice.sendEphemeral({
			key: "cursor",
			userId: "u-alice",
			data: { x: 7 },
			transport: "p2p",
		});

		await waitFor(() => received.length === 1);
		// Identity from the server-relayed signaling; the sequence field stripped.
		expect(received[0]).toMatchObject({ clientId: "alice", userId: "u-alice", data: { x: 7 } });
		expect(room.framesFrom("alice", "cursor")).toEqual([]);
	});

	test("auto sends every frame to peers and a throttled copy, ending on the last value, to the server", async () => {
		room = createRoom();
		const alice = await room.join("alice");
		const bob = await room.join("bob");
		const meshA = room.mesh(alice, { serverIntervalMs: 200 });
		room.mesh(bob);
		await waitFor(() => connected(meshA, "bob"));

		const received: number[] = [];
		bob.subscribeEphemeral("cursor", (e) => received.push(e.data.x as number));
		for (let x = 1; x <= 20; x++) {
			await alice.sendEphemeral({ key: "cursor", userId: "u-alice", data: { x } });
		}
		await waitFor(() => received.includes(20));
		await new Promise((r) => setTimeout(r, 300));

		// Every frame arrived in order: peer-to-peer copies first, and the
		// slower server copies of the same frames dropped as stale.
		expect(received).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		const toServer = room.framesFrom("alice", "cursor");
		expect(toServer.length).toBeLessThanOrEqual(3);
		const last = toServer.at(-1)!.message as Extract<ClientMessage, { type: "ephemeral" }>;
		expect(last.data.x).toBe(20);
	});

	test("with nobody connected, auto sends every frame through the server", async () => {
		room = createRoom();
		const alice = await room.join("alice");
		room.mesh(alice);

		for (let x = 1; x <= 5; x++) {
			await alice.sendEphemeral({ key: "cursor", userId: "u-alice", data: { x } });
		}
		expect(room.framesFrom("alice", "cursor").length).toBe(5);
	});

	test("peers are identified by the server's connection id, not the configured one", async () => {
		room = createRoom();
		// Configured ids sort the opposite way to the connection ids, so a mesh
		// using the wrong one would pick the wrong initiator and never connect.
		const alice = await room.join("alice", "acme", "zzz-tab");
		const bob = await room.join("bob", "acme", "aaa-tab");
		const meshA = room.mesh(alice);
		const meshB = room.mesh(bob);

		expect(meshA.clientId).toBe("alice");
		await waitFor(() => connected(meshA, "bob") && connected(meshB, "alice"));
	});

	test("a newcomer that must open the connection learns of an existing peer without waiting for its next announce", async () => {
		room = createRoom();
		const alice = await room.join("alice");
		const bob = await room.join("bob");
		// Bob's mesh announces first, while Alice has no mesh to hear it. Alice
		// (the lower id, so the one who must open) only hears of Bob when he
		// answers her announce.
		const meshB = room.mesh(bob, { announceIntervalMs: 60_000 });
		await new Promise((r) => setTimeout(r, 50));
		const meshA = room.mesh(alice, { announceIntervalMs: 60_000 });

		await waitFor(() => connected(meshA, "bob") && connected(meshB, "alice"), 4000);
	});

	test("a peer that never answers falls back to the server path", async () => {
		room = createRoom();
		const alice = await room.join("alice");
		const bob = await room.join("bob");
		const meshA = room.mesh(alice, { connectTimeoutMs: 300, serverIntervalMs: 1000 });
		// Bob looks like a mesh (an old client, or one whose WebRTC is blocked)
		// but never answers an offer.
		await bob.sendEphemeral({
			key: "__rtc",
			userId: "",
			data: { v: 1, call: false },
			transport: "server",
		});

		await waitFor(() => meshA.getSnapshot().peers[0]?.state === "server-only");
		// A late announce inside the cool-down does not start another attempt.
		await bob.sendEphemeral({
			key: "__rtc",
			userId: "",
			data: { v: 1, call: false },
			transport: "server",
		});
		await new Promise((r) => setTimeout(r, 100));
		expect(meshA.getSnapshot().peers).toEqual([
			{ clientId: "bob", userId: "u-bob", state: "server-only", inCall: false },
		]);

		// Bob is not reached directly, so auto must not throttle the server copy.
		for (let x = 1; x <= 3; x++) {
			await alice.sendEphemeral({ key: "cursor", userId: "u-alice", data: { x } });
		}
		expect(room.framesFrom("alice", "cursor").length).toBe(3);
	});

	test("joining twice while the camera prompt is open captures one stream", async () => {
		room = createRoom();
		const alice = await room.join("alice");
		const mesh = room.mesh(alice);
		const stopped: string[] = [];
		const fakeStream = (id: string) =>
			({
				id,
				getTracks: () => [{ stop: () => stopped.push(id) }],
				getAudioTracks: () => [],
				getVideoTracks: () => [],
			}) as unknown as MediaStream;
		let requests = 0;
		const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: {
				mediaDevices: {
					getUserMedia: async () => {
						requests++;
						await new Promise((r) => setTimeout(r, 50));
						return fakeStream(`cam-${requests}`);
					},
				},
			},
		});
		try {
			await Promise.all([mesh.call(), mesh.call()]);
			expect(requests).toBe(1);
			expect(mesh.getSnapshot().call?.camera?.id).toBe("cam-1");

			mesh.leave();
			expect(stopped).toEqual(["cam-1"]);
			expect(mesh.getSnapshot().call).toBeNull();
		} finally {
			if (original) Object.defineProperty(globalThis, "navigator", original);
		}
	});

	test("a connection that drops and does not recover is treated as the peer leaving", async () => {
		room = createRoom();
		const alice = await room.join("alice");
		const bob = await room.join("bob");
		SpecPeerConnection.instances = [];
		const meshA = room.mesh(alice, { connectTimeoutMs: 300, serverIntervalMs: 1000 });
		room.mesh(bob);
		await waitFor(() => connected(meshA, "bob"));
		// Alice has the lower id, so she opened first: hers is the first connection made.
		const alicePc = SpecPeerConnection.instances[0]!;

		alicePc.loseConnection("disconnected");
		expect(meshA.getSnapshot().peers[0]!.state).toBe("connecting");
		// Off the direct path, so every frame goes to the server again.
		for (let x = 1; x <= 3; x++) {
			await alice.sendEphemeral({ key: "cursor", userId: "u-alice", data: { x } });
		}
		expect(room.framesFrom("alice", "cursor").length).toBe(3);

		await waitFor(() => meshA.getSnapshot().peers.length === 0);
	});

	test("peers in different rooms never connect", async () => {
		room = createRoom();
		const alice = await room.join("alice", "acme");
		const eve = await room.join("eve", "other");
		const meshA = room.mesh(alice);
		const meshE = room.mesh(eve);

		await new Promise((r) => setTimeout(r, 500));
		expect(meshA.getSnapshot().peers).toEqual([]);
		expect(meshE.getSnapshot().peers).toEqual([]);
	});

	test("a peer that destroys its mesh disappears from the other side", async () => {
		room = createRoom();
		const alice = await room.join("alice");
		const bob = await room.join("bob");
		const meshA = room.mesh(alice);
		const meshB = room.mesh(bob);
		await waitFor(() => connected(meshA, "bob"));

		meshB.destroy();
		// Gone from the list, not left behind as an unreachable entry.
		await waitFor(() => meshA.getSnapshot().peers.length === 0);
		// Bob's client is back on the plain server path.
		await bob.sendEphemeral({ key: "cursor", userId: "u-bob", data: { x: 1 } });
		expect(room.framesFrom("bob", "cursor").length).toBe(1);
	});
});

describe("SyncClient ephemeral routing", () => {
	function bareClient() {
		const sent: ClientMessage[] = [];
		let handler: ((message: ServerMessage) => void) | null = null;
		const client = new SyncClient({
			clientId: "me",
			token: "t",
			transport: {
				async send(message) {
					sent.push(message);
				},
				subscribe(h) {
					handler = h;
				},
				async close() {},
			},
		});
		return { client, sent, deliver: (m: ServerMessage) => handler?.(m) };
	}

	test("without a mesh, p2p frames go nowhere and the route never reaches the wire", async () => {
		const { client, sent } = bareClient();
		await client.sendEphemeral({ key: "k", userId: "u", data: { a: 1 }, transport: "p2p" });
		await client.sendEphemeral({ key: "k", userId: "u", data: { a: 2 }, transport: "auto" });
		expect(sent).toEqual([{ type: "ephemeral", key: "k", userId: "u", data: { a: 2 } }]);
	});

	test("drops a frame older than one already delivered for the same peer and key", () => {
		const { client, deliver } = bareClient();
		const seen: unknown[] = [];
		client.subscribeEphemeral("cursor", (e) => seen.push(e.data));
		const frame = (x: number, seq: number, from = "peer"): ServerMessage => ({
			type: "ephemeral",
			key: "cursor",
			clientId: from,
			userId: "u",
			data: { x, __seq: seq },
		});

		deliver(frame(1, 10));
		deliver(frame(2, 12));
		deliver(frame(1, 10)); // the same frame, arriving again over the server
		deliver(frame(9, 11)); // out of order
		deliver(frame(3, 1, "other")); // a different peer has its own sequence
		client.receiveEphemeral({
			type: "ephemeral",
			key: "cursor",
			clientId: "peer",
			userId: "u",
			data: { x: 4 },
		});

		expect(seen).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }]);
	});
});
