import { expect, test } from "bun:test";
import { defineSyncQueries, t } from "../../src/core/index.ts";
import { createSyncServer } from "../../src/server/index.ts";
import { createRedisEphemeral } from "../../src/server/ephemeral/redis.ts";
import { createMemoryEphemeral } from "../../src/server/ephemeral/memory.ts";
import type { EphemeralAdapter } from "../../src/server/ephemeral/types.ts";
import { createMockTransport } from "../server/helpers.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";

const queries = defineSyncQueries({
	todos: { row: t<{ id: string; title: string }>(), conflict: "lww" },
});

test("the documented ephemeral config shape type-checks and constructs", async () => {
	// Guards the README example: swapping the adapter must stay a config-level
	// change, with no cast at the call site.
	const redisLike = { call: async () => null };
	const adapter: EphemeralAdapter = createRedisEphemeral({ client: redisLike });

	const server = createSyncServer({
		queries,
		db: {},
		transport: createMockTransport(),
		ephemeral: { adapter },
	});
	expect(server).toBeDefined();
	await server.close();

	// maxEntries alone tunes the default in-process store.
	const tuned = createSyncServer({
		queries,
		db: {},
		transport: createMockTransport(),
		ephemeral: { maxEntries: 50 },
	});
	expect(tuned).toBeDefined();
	await tuned.close();
});

test("the memory adapter satisfies the adapter interface", () => {
	const adapter: EphemeralAdapter = createMemoryEphemeral(10);
	expect(adapter.set("r", "cursor", "c1", "u1", { x: 1 })).toBe(true);
	expect(adapter.publish).toBeUndefined();
	expect(adapter.subscribe).toBeUndefined();
});

test("the typed server actually routes presence through the configured adapter", async () => {
	// createSyncServer forwards a whitelist of config fields; a field missing
	// from that list type-checks and is then silently ignored at runtime.
	const store = createMemoryEphemeral();
	const sets: Array<{ room: string; key: string; clientId: string }> = [];
	const adapter: EphemeralAdapter = {
		set(room, key, clientId, userId, data, ttlMs) {
			sets.push({ room, key, clientId });
			return store.set(room, key, clientId, userId, data, ttlMs);
		},
		get: (room, key) => store.get(room, key),
		getRoom: (room) => store.getRoom(room),
		remove: (room, key, clientId) => store.remove(room, key, clientId),
		removeClient: (clientId) => store.removeClient(clientId),
		cleanupExpired: () => store.cleanupExpired(),
		size: () => store.size(),
		destroy: () => store.destroy(),
	};

	const transport = createMockTransport();
	const server = createSyncServer({
		queries,
		db: {},
		transport,
		ephemeral: { adapter },
	});
	server.auth(async () => ({ userId: "u1" }));
	server.implement("todos", { query: () => [], tables: ["todos"] });
	server.room("org/:orgId", () => {});

	transport.connectHandler!("c1", new Request("https://sync"));
	transport.messageHandler!("c1", {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId: "c1",
		token: "t",
	});
	await new Promise((r) => setTimeout(r, 10));
	transport.messageHandler!("c1", {
		type: "sync_declare",
		table: "todos",
		params: { orgId: "acme" },
	});
	await new Promise((r) => setTimeout(r, 10));
	transport.messageHandler!("c1", {
		type: "ephemeral",
		key: "cursor",
		userId: "u1",
		data: { x: 1 },
	});
	await new Promise((r) => setTimeout(r, 30));

	expect(sets).toEqual([{ room: "org/acme", key: "cursor", clientId: "c1" }]);
	await server.close();
});
