import { describe, expect, test } from "bun:test";
import { MessageHandler } from "../../src/server/handler.ts";
import type { StorageAdapter } from "../../src/server/handler.ts";
import { createMockTransport } from "./helpers.ts";
import { compareHlc, packHlc } from "../../src/core/hlc.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import type { ServerMessage } from "../../src/core/types.ts";

async function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Minimal storage whose meta map can be shared between handler instances. */
function createStorage(meta = new Map<string, string>()): StorageAdapter & {
	meta: Map<string, string>;
} {
	return {
		meta,
		async getRow() {
			return { row: null, rowHlc: null, colClocks: {} };
		},
		async putRow() {},
		async getRows() {
			return { rows: [], colClocks: {} };
		},
		async appendOp() {},
		async applyOp() {},
		async getOpsSince() {
			return [];
		},
		async deleteOpsBefore() {
			return 0;
		},
		async reserveOp() {
			return true;
		},
		async getMeta(key) {
			return meta.get(key) ?? null;
		},
		async setMeta(key, value) {
			meta.set(key, value);
		},
	};
}

async function bootstrapHlc(
	handler: MessageHandler,
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
): Promise<string> {
	transport.connectHandler!(clientId, new Request("https://sync"));
	transport.messageHandler!(clientId, {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId,
		token: "t",
	});
	await tick();
	transport.messageHandler!(clientId, { type: "bootstrap" });
	await tick();
	const complete = transport.sentMessages.find(
		(m) => m.clientId === clientId && m.message.type === "bootstrap_complete",
	)?.message as Extract<ServerMessage, { type: "bootstrap_complete" }>;
	return complete.serverHlc;
}

describe("server HLC durability", () => {
	test("persists a watermark and resumes above it after restart", async () => {
		const meta = new Map<string, string>();

		const t1 = createMockTransport();
		const h1 = new MessageHandler({ transport: t1, serverId: "s1", db: {} });
		h1.setAuth(async () => ({ userId: "u1" }));
		h1.setStorage(createStorage(meta));

		const firstHlc = await bootstrapHlc(h1, t1, "c1");
		await h1.close();

		expect(meta.get("serverHlcWatermark")).toBeDefined();
		// The watermark leads the clock so a crash inside the throttle window
		// still restarts above every HLC handed out.
		expect(compareHlc(meta.get("serverHlcWatermark")!, firstHlc)).toBeGreaterThan(0);

		// Restart with a wall clock that has stepped backwards. Without the
		// persisted watermark the fresh handler would stamp below firstHlc and
		// clients would silently drop the deltas that follow.
		const realNow = Date.now;
		Date.now = () => realNow() - 60_000;
		try {
			const t2 = createMockTransport();
			const h2 = new MessageHandler({ transport: t2, serverId: "s1", db: {} });
			h2.setAuth(async () => ({ userId: "u1" }));
			h2.setStorage(createStorage(meta));

			const secondHlc = await bootstrapHlc(h2, t2, "c2");
			expect(compareHlc(secondHlc, firstHlc)).toBeGreaterThan(0);
			await h2.close();
		} finally {
			Date.now = realNow;
		}
	});

	test("syncClockWatermark merges a peer instance's watermark", async () => {
		const meta = new Map<string, string>();
		const transport = createMockTransport();
		const handler = new MessageHandler({ transport, serverId: "lagging", db: {} });
		handler.setAuth(async () => ({ userId: "u1" }));
		handler.setStorage(createStorage(meta));

		// A peer with a clock 2 minutes ahead publishes its watermark.
		const peerHlc = packHlc({
			ms: Date.now() + 120_000,
			counter: 0,
			nodeId: "server:peer",
		});
		meta.set("serverHlcWatermark", peerHlc);

		await handler.syncClockWatermark();
		const stamped = await bootstrapHlc(handler, transport, "c1");

		expect(compareHlc(stamped, peerHlc)).toBeGreaterThan(0);
		await handler.close();
	});

	test("a lagging instance never lowers the shared watermark", async () => {
		const meta = new Map<string, string>();
		// A peer 2 minutes ahead — within MAX_CLOCK_DRIFT_MS, so we follow it.
		// Beyond that ceiling the clamp deliberately refuses to follow, which is
		// the anti-runaway protection, not a monotonicity bug.
		const peerHlc = packHlc({
			ms: Date.now() + 120_000,
			counter: 0,
			nodeId: "server:peer",
		});
		meta.set("serverHlcWatermark", peerHlc);

		const transport = createMockTransport();
		const handler = new MessageHandler({ transport, serverId: "lagging", db: {} });
		handler.setAuth(async () => ({ userId: "u1" }));
		handler.setStorage(createStorage(meta));

		await bootstrapHlc(handler, transport, "c1");
		await handler.close();

		// Writing `ourClock + lease` blindly would move the shared watermark
		// backwards and erode the protection for every instance.
		expect(
			compareHlc(meta.get("serverHlcWatermark")!, peerHlc),
		).toBeGreaterThanOrEqual(0);
	});

	test("works without storage", async () => {
		const transport = createMockTransport();
		const handler = new MessageHandler({ transport, serverId: "s1", db: {} });
		handler.setAuth(async () => ({ userId: "u1" }));

		const hlc = await bootstrapHlc(handler, transport, "c1");
		expect(hlc.length).toBeGreaterThan(0);
		await handler.close();
	});
});
