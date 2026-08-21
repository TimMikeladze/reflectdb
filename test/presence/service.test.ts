import { afterEach, describe, expect, test } from "bun:test";
import { PRESENCE_PROTOCOL_VERSION } from "../../services/presence/protocol.ts";
import { MAX_PAYLOAD_BYTES } from "../../services/presence/protocol.ts";
import { createFakeSink, open, publish, settle, setup, type Harness } from "./helpers.ts";

const open_harnesses: Harness[] = [];

function harness(...args: Parameters<typeof setup>): Harness {
	const created = setup(...args);
	open_harnesses.push(created);
	return created;
}

afterEach(async () => {
	// Every harness holds real interval timers for its rooms; leaving them
	// running leaks polls into the next test's assertions.
	for (const created of open_harnesses.splice(0)) await created.service.shutdown();
});

describe("presence service", () => {
	test("a stream opens with welcome and a snapshot", async () => {
		const h = harness();
		const sink = await open(h, "key-live", "board-1", "c1");

		const welcome = sink.last("welcome");
		expect(welcome).toBeDefined();
		expect(welcome!.protocolVersion).toBe(PRESENCE_PROTOCOL_VERSION);
		expect(welcome!.clientId).toBe("c1");
		expect(welcome!.room).toBe("board-1");
		expect(sink.last("snapshot")!.peers).toEqual([]);
		expect(sink.closed).toBe(false);
	});

	test("an unknown API key is refused as a frame, not a status", async () => {
		const h = harness();
		const sink = await open(h, "nope", "board-1", "c1");

		// An `EventSource` cannot read a status code, so the refusal has to
		// arrive on the stream or the client retries forever without knowing why.
		const error = sink.last("error");
		expect(error).toBeDefined();
		expect(error!.code).toBe("unauthorized");
		expect(error!.fatal).toBe(true);
		expect(sink.closed).toBe(true);
		expect(sink.framesOfType("welcome")).toHaveLength(0);
	});

	test("a joiner sees peers who arrived before it", async () => {
		const h = harness();
		await publish(
			h,
			"key-live",
			"board-1",
			"early",
			"cursor",
			{ x: 1 },
			{
				identity: { name: "Ada" },
			},
		);

		const sink = await open(h, "key-live", "board-1", "late");
		const snapshot = sink.last("snapshot")!;
		expect(snapshot.peers).toHaveLength(1);
		expect(snapshot.peers[0]).toMatchObject({
			clientId: "early",
			channel: "cursor",
			data: { x: 1 },
			identity: { name: "Ada" },
		});
	});

	test("a snapshot never contains the joiner's own state", async () => {
		const h = harness();
		await publish(h, "key-live", "board-1", "self", "cursor", { x: 1 });

		const sink = await open(h, "key-live", "board-1", "self");
		expect(sink.last("snapshot")!.peers).toEqual([]);
	});

	test("a publish reaches peers and never echoes to the publisher", async () => {
		const h = harness();
		const peer = await open(h, "key-live", "board-1", "peer");
		const author = await open(h, "key-live", "board-1", "author");

		await publish(h, "key-live", "board-1", "author", "cursor", { x: 7 });
		await settle();

		const seen = peer.framesOfType("presence");
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]).toMatchObject({ clientId: "author", channel: "cursor", data: { x: 7 } });
		expect(author.framesOfType("presence")).toHaveLength(0);
	});

	test("a room in another project never receives the frame", async () => {
		const h = harness();
		const outsider = await open(h, "key-other", "board-1", "outsider");

		await publish(h, "key-live", "board-1", "insider", "cursor", { x: 1 });
		await settle();

		expect(outsider.framesOfType("presence")).toHaveLength(0);
		expect(outsider.last("snapshot")!.peers).toEqual([]);
	});

	test("leaving drops the peer for everyone still watching", async () => {
		const h = harness();
		const peer = await open(h, "key-live", "board-1", "peer");
		await publish(h, "key-live", "board-1", "goer", "cursor", { x: 1 });
		await settle();

		await h.service.leave({ apiKey: "key-live", room: "board-1", clientId: "goer" });
		await settle();

		const leaves = peer.framesOfType("leave");
		expect(leaves).toHaveLength(1);
		expect(leaves[0]).toMatchObject({ clientId: "goer", channel: "cursor" });
	});

	test("clearing one channel leaves the other alone", async () => {
		const h = harness();
		const peer = await open(h, "key-live", "board-1", "peer");
		await publish(h, "key-live", "board-1", "author", "cursor", { x: 1 });
		await publish(h, "key-live", "board-1", "author", "here", {});
		await settle();

		await h.service.leave({
			apiKey: "key-live",
			room: "board-1",
			clientId: "author",
			channel: "cursor",
		});
		await settle();

		expect(peer.framesOfType("leave")).toEqual([
			{ type: "leave", clientId: "author", channel: "cursor" },
		]);
		const stillThere = await h.store.room("proj-1", "board-1");
		expect(stillThere.map((entry) => entry.channel)).toEqual(["here"]);
	});

	test("an expired entry becomes a leave without anyone announcing it", async () => {
		// The TTL is the only thing covering a tab that closed without its
		// beacon getting out, so the poll has to notice on its own.
		let clock = 1_000_000;
		const h = harness({ now: () => clock });
		const peer = await open(h, "key-live", "board-1", "peer");

		await publish(h, "key-live", "board-1", "ghost", "cursor", { x: 1 }, { ttlMs: 50 });
		await settle();
		expect(peer.framesOfType("presence").length).toBeGreaterThan(0);

		clock += 100;
		await settle();

		expect(peer.framesOfType("leave")).toEqual([
			{ type: "leave", clientId: "ghost", channel: "cursor" },
		]);
	});

	test("publishing past the per-second ceiling is refused without ending the stream", async () => {
		const h = harness();
		const sink = await open(h, "key-slow", "board-1", "spammer");

		expect((await publish(h, "key-slow", "board-1", "spammer", "cursor", { x: 1 })).ok).toBe(true);
		const second = await publish(h, "key-slow", "board-1", "spammer", "cursor", { x: 2 });

		expect(second).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
		expect(sink.closed).toBe(false);
	});

	test("a room at its entry limit refuses the next client", async () => {
		const h = harness();
		expect((await publish(h, "key-tiny", "board-1", "first", "cursor", { x: 1 })).ok).toBe(true);

		const second = await publish(h, "key-tiny", "board-1", "second", "cursor", { x: 1 });
		expect(second).toMatchObject({ ok: false, status: 409, code: "room_full" });
	});

	test("a project at its client cap still readmits a client it already has", async () => {
		// Streams recycle about once a minute, so a reconnecting client that
		// counted as a new occupant would lock a full project into a loop where
		// its own users evict themselves.
		const h = harness();
		await publish(h, "key-tiny", "board-1", "resident", "cursor", { x: 1 });

		const returning = await open(h, "key-tiny", "board-1", "resident");
		expect(returning.last("welcome")).toBeDefined();

		const newcomer = await open(h, "key-tiny", "board-1", "newcomer");
		expect(newcomer.last("error")).toMatchObject({
			code: "project_connection_limit",
			fatal: true,
		});
		expect(newcomer.closed).toBe(true);
	});

	test("an oversized payload is refused", async () => {
		const h = harness();
		const huge = { blob: "x".repeat(MAX_PAYLOAD_BYTES) };
		expect(await publish(h, "key-live", "board-1", "c1", "cursor", huge)).toMatchObject({
			ok: false,
			status: 413,
		});
	});

	test("a stream says goodbye before it recycles, rather than dying mid-frame", async () => {
		const h = harness({ streamMs: 20 });
		const sink = await open(h, "key-live", "board-1", "c1");
		await settle(60);

		expect(sink.last("bye")).toEqual({ type: "bye", reason: "recycle" });
		expect(sink.closed).toBe(true);
	});

	test("the last stream leaving a room stops the room being polled", async () => {
		const h = harness();
		const sink = await open(h, "key-live", "board-1", "c1");
		expect(h.service.metrics()).toMatchObject({ streams: 1, rooms: 1 });

		const { closeStream } = await import("../../services/presence/service.ts");
		closeStream(sink);

		expect(h.service.metrics()).toMatchObject({ streams: 0, rooms: 0 });
	});

	test("metrics report what the instance is holding", async () => {
		const h = harness();
		await open(h, "key-live", "board-1", "c1");
		await open(h, "key-live", "board-1", "c2");
		await open(h, "key-live", "board-2", "c3");
		await publish(h, "key-live", "board-1", "c1", "cursor", { x: 1 });
		await open(h, "nope", "board-1", "c4");

		expect(h.service.metrics()).toMatchObject({
			streams: 3,
			rooms: 2,
			messagesPublished: 1,
			requestsRejected: 1,
		});
	});

	test("a fresh sink joining mid-room is handed the room, not an empty one", async () => {
		const h = harness();
		await open(h, "key-live", "board-1", "first");
		await publish(h, "key-live", "board-1", "first", "cursor", { x: 1 });
		await settle();

		const late = createFakeSink();
		await h.service.openStream({ apiKey: "key-live", room: "board-1", clientId: "late" }, late);
		expect(late.last("snapshot")!.peers).toHaveLength(1);
	});
});
