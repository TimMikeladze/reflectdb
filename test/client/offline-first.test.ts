import { describe, expect, test } from "bun:test";
import { SyncClient } from "../../src/client/sync-client.ts";
import { createMemoryStorage } from "../../src/client/storage/memory.ts";
import type { ClientStorageAdapter } from "../../src/client/storage/types.ts";
import type {
	ClientMessage,
	ServerMessage,
	ClientTransport,
	ResumeMessage,
} from "../../src/core/types.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import { packHlc } from "../../src/core/hlc.ts";

function createMockTransport(): ClientTransport & {
	sentMessages: ClientMessage[];
	handler: ((message: ServerMessage) => void) | null;
	simulateMessage(message: ServerMessage): void;
} {
	const transport = {
		sentMessages: [] as ClientMessage[],
		handler: null as ((message: ServerMessage) => void) | null,

		async send(message: ClientMessage): Promise<void> {
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

function makeClient(
	storage: ClientStorageAdapter,
	transport?: ReturnType<typeof createMockTransport>,
) {
	const t = transport ?? createMockTransport();
	const client = new SyncClient({
		clientId: "test-client",
		transport: t,
		token: "valid-token",
		storage,
	});
	return { client, transport: t };
}

async function connectClient(
	client: SyncClient,
	transport: ReturnType<typeof createMockTransport>,
) {
	const p = client.connect();
	transport.simulateMessage({
		type: "hello_ack",
		protocolVersion: PROTOCOL_VERSION,
		serverId: "test-srv",
	});
	await p;
}

async function connectAndBootstrap(
	client: SyncClient,
	transport: ReturnType<typeof createMockTransport>,
	tables: string[] = ["posts"],
) {
	// init() must be called before connect() so that connect doesn't
	// hit await init() internally (which would cause simulated hello_ack
	// to arrive before connectResolve is set up)
	await client.init();

	await connectClient(client, transport);

	for (const table of tables) {
		await client.sync(table);
	}

	await client.bootstrap();

	for (const table of tables) {
		transport.simulateMessage({
			type: "snapshot",
			table,
			rows: [],
			colClocks: {},
		});
	}

	const serverHlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" });
	transport.simulateMessage({
		type: "bootstrap_complete",
		serverHlc,
		tableMeta: Object.fromEntries(tables.map((t) => [t, { serverSet: [], readonly: [] }])),
	});
}

describe("Offline-First Integration", () => {
	test("full restart cycle preserves data", async () => {
		const storage = createMemoryStorage();

		// Session 1: connect, bootstrap, insert data
		const { client: client1, transport: t1 } = makeClient(storage);
		await connectAndBootstrap(client1, t1);

		client1.insert("posts", "r1", { title: "first post" });
		client1.insert("posts", "r2", { title: "second post" });

		// Ack the ops so they're not pending
		const ops = client1.getStore().getPendingOps();
		t1.simulateMessage({ type: "ack", opIds: ops.map((p) => p.op.id) });

		// Flush writes to storage
		await client1.getStore().flush();
		await client1.close();

		// Session 2: new client with same storage — data should be available after init
		const { client: client2 } = makeClient(storage);
		await client2.init();

		expect(client2.getState()).toBe("disconnected");
		expect(client2.getRows("posts")).toHaveLength(2);
		expect(client2.getRow("posts", "r1")).toEqual({ title: "first post" });
		expect(client2.getRow("posts", "r2")).toEqual({ title: "second post" });
	});

	test("pending ops survive restart", async () => {
		const storage = createMemoryStorage();

		// Session 1: insert without ack (pending ops)
		const { client: client1, transport: t1 } = makeClient(storage);
		await connectAndBootstrap(client1, t1);

		client1.insert("posts", "r1", { title: "pending post" });
		await client1.getStore().flush();
		await client1.close();

		// Session 2: pending ops should be restored
		const { client: client2 } = makeClient(storage);
		await client2.init();

		expect(client2.getPendingCount()).toBe(1);
		expect(client2.getRow("posts", "r1")).toEqual({ title: "pending post" });
	});

	test("offline mutations → connect → push → ack", async () => {
		const storage = createMemoryStorage();

		// Session 1: bootstrap and close
		const { client: client1, transport: t1 } = makeClient(storage);
		await connectAndBootstrap(client1, t1);
		await client1.getStore().flush();
		await client1.close();

		// Session 2: init, insert offline, then connect and push
		const t2 = createMockTransport();
		const { client: client2, transport: transport2 } = makeClient(storage, t2);
		await client2.init();

		// Insert while offline — synchronous, no network
		client2.insert("posts", "r1", { title: "offline post" });
		expect(client2.getRow("posts", "r1")).toEqual({ title: "offline post" });
		expect(client2.getPendingCount()).toBe(1);

		// Connect
		await connectClient(client2, transport2);

		// Push pending ops
		transport2.sentMessages.length = 0;
		await client2.push();

		const opsMsg = transport2.sentMessages.find((m) => m.type === "ops");
		expect(opsMsg).toBeDefined();

		// Ack
		const pendingOps = client2.getStore().getPendingOps();
		transport2.simulateMessage({
			type: "ack",
			opIds: pendingOps.map((p) => p.op.id),
		});

		expect(client2.getPendingCount()).toBe(0);
	});

	test("resume uses persisted serverHlc (delta catch-up, not full bootstrap)", async () => {
		const storage = createMemoryStorage();
		const serverHlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" });

		// Session 1: bootstrap to establish serverHlc
		const { client: client1, transport: t1 } = makeClient(storage);
		await client1.init();
		await connectClient(client1, t1);
		await client1.sync("posts");
		await client1.bootstrap();
		t1.simulateMessage({ type: "snapshot", table: "posts", rows: [], colClocks: {} });
		t1.simulateMessage({
			type: "bootstrap_complete",
			serverHlc,
			tableMeta: { posts: { serverSet: [], readonly: [] } },
		});
		await client1.getStore().flush();
		await client1.close();

		// Session 2: resume should send "resume" not "bootstrap"
		const t2 = createMockTransport();
		const { client: client2, transport: transport2 } = makeClient(storage, t2);
		await client2.init();
		await connectClient(client2, transport2);

		transport2.sentMessages.length = 0;
		await client2.resume();

		const resumeMsg = transport2.sentMessages.find((m) => m.type === "resume") as
			| ResumeMessage
			| undefined;
		expect(resumeMsg).toBeDefined();
		expect(resumeMsg!.since).toBe(serverHlc);

		// Should NOT have sent bootstrap
		const bootstrapMsg = transport2.sentMessages.find((m) => m.type === "bootstrap");
		expect(bootstrapMsg).toBeUndefined();
	});

	test("HLC state persisted (no clock regression)", async () => {
		const storage = createMemoryStorage();

		// Session 1: insert some ops to advance the HLC
		const { client: client1, transport: t1 } = makeClient(storage);
		await connectAndBootstrap(client1, t1);
		const op1 = client1.insert("posts", "r1", { title: "first" });
		const hlc1 = op1.hlc;
		await client1.getStore().flush();
		await client1.close();

		// Session 2: new op should have HLC >= previous
		const { client: client2 } = makeClient(storage);
		await client2.init();
		const op2 = client2.insert("posts", "r2", { title: "second" });
		const hlc2 = op2.hlc;

		// HLC is lexicographically comparable
		expect(hlc2 > hlc1).toBe(true);
	});

	test("init() transitions through hydrating → disconnected", async () => {
		const storage = createMemoryStorage();
		const { client } = makeClient(storage);

		const states: string[] = [];
		client.subscribe(() => {
			states.push(client.getState());
		});

		await client.init();

		expect(states).toContain("hydrating");
		expect(states[states.length - 1]).toBe("disconnected");
	});

	test("cached data available after init, before connect", async () => {
		const storage = createMemoryStorage();

		// Session 1: populate data
		const { client: client1, transport: t1 } = makeClient(storage);
		await connectAndBootstrap(client1, t1);
		client1.insert("posts", "r1", { title: "cached" });
		const ops = client1.getStore().getPendingOps();
		t1.simulateMessage({ type: "ack", opIds: ops.map((p) => p.op.id) });
		await client1.getStore().flush();
		await client1.close();

		// Session 2: init but don't connect
		const { client: client2 } = makeClient(storage);
		await client2.init();

		// Data available without connection
		expect(client2.getRows("posts")).toHaveLength(1);
		expect(client2.getRow("posts", "r1")).toEqual({ title: "cached" });
		expect(client2.getState()).toBe("disconnected");
	});

	test("sync subscriptions restored after restart", async () => {
		const storage = createMemoryStorage();

		// Session 1: sync posts and comments
		const { client: client1, transport: t1 } = makeClient(storage);
		await client1.init();
		await connectClient(client1, t1);
		await client1.sync("posts", { orgId: "org-1" });
		await client1.sync("comments");
		await client1.bootstrap();
		const serverHlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" });
		t1.simulateMessage({ type: "snapshot", table: "posts", rows: [], colClocks: {} });
		t1.simulateMessage({ type: "snapshot", table: "comments", rows: [], colClocks: {} });
		t1.simulateMessage({
			type: "bootstrap_complete",
			serverHlc,
			tableMeta: {
				posts: { serverSet: [], readonly: [] },
				comments: { serverSet: [], readonly: [] },
			},
		});
		await client1.getStore().flush();
		await client1.close();

		// Session 2: check stored subscriptions via meta
		const subsJson = await storage.getMeta("syncSubscriptions");
		expect(subsJson).not.toBeNull();
		const subs = JSON.parse(subsJson!);
		expect(subs).toHaveLength(2);
		expect(subs[0].table).toBe("posts");
		expect(subs[0].params).toEqual({ orgId: "org-1" });
		expect(subs[1].table).toBe("comments");
	});

	test("clear() resets all persisted state", async () => {
		const storage = createMemoryStorage();

		// Populate
		const { client: client1, transport: t1 } = makeClient(storage);
		await connectAndBootstrap(client1, t1);
		client1.insert("posts", "r1", { title: "hello" });
		await client1.getStore().flush();

		// Clear
		await client1.clear();

		expect(client1.getRows("posts")).toHaveLength(0);
		expect(client1.getPendingCount()).toBe(0);
		expect(client1.getState()).toBe("disconnected");

		// Storage should be empty
		expect(await storage.getAllRows()).toHaveLength(0);
		expect(await storage.getPendingOps()).toHaveLength(0);
		expect(await storage.getMeta("serverHlc")).toBeNull();
	});

	test("no storage = identical to original behavior", async () => {
		const transport = createMockTransport();
		const client = new SyncClient({
			clientId: "test-client",
			transport,
			token: "valid-token",
		});

		// connect works fine without init
		const cp = client.connect();
		transport.simulateMessage({
			type: "hello_ack",
			protocolVersion: PROTOCOL_VERSION,
			serverId: "test-srv",
		});
		await cp;
		expect(client.getState()).toBe("connected");

		client.insert("posts", "r1", { title: "hello" });
		expect(client.getRow("posts", "r1")).toEqual({ title: "hello" });
	});

	test("table meta persisted and restored", async () => {
		const storage = createMemoryStorage();

		// Session 1: bootstrap sets table meta
		const { client: client1, transport: t1 } = makeClient(storage);
		await connectAndBootstrap(client1, t1);
		await client1.getStore().flush();
		await client1.close();

		// Session 2: table meta should be restored
		const { client: client2 } = makeClient(storage);
		await client2.init();

		const meta = client2.getStore().getTableMeta("posts");
		expect(meta).toBeDefined();
		expect(meta!.serverSet).toEqual([]);
		expect(meta!.readonly).toEqual([]);
	});
});

describe("scoped hydration", () => {
	function countingStorage(): ClientStorageAdapter & {
		allRowsCalls: number;
		tableReads: string[];
	} {
		const base = createMemoryStorage();
		const wrapper = {
			...base,
			allRowsCalls: 0,
			tableReads: [] as string[],
			async getAllRows() {
				wrapper.allRowsCalls++;
				return base.getAllRows();
			},
			async getRows(table: string) {
				wrapper.tableReads.push(table);
				return base.getRows(table);
			},
		};
		return wrapper;
	}

	test("reads only the tables this client subscribes to", async () => {
		const storage = countingStorage();
		await storage.putRow("todos", "t1", {
			table: "todos",
			rowId: "t1",
			data: { id: "t1" },
			colClocks: {},
			serverHlc: null,
		});
		await storage.putRow("archive", "a1", {
			table: "archive",
			rowId: "a1",
			data: { id: "a1" },
			colClocks: {},
			serverHlc: null,
		});
		await storage.setMeta("syncSubscriptions", JSON.stringify([{ table: "todos" }]));

		const { client } = makeClient(storage);
		await client.init();

		expect(storage.allRowsCalls).toBe(0);
		expect(storage.tableReads).toEqual(["todos"]);
		expect(client.getRows("todos").length).toBe(1);
		// `archive` was never subscribed, so its rows stay on disk until it is.
		expect(client.getRows("archive").length).toBe(0);
		await client.close();
	});

	test("falls back to a full read with no persisted subscriptions", async () => {
		const storage = countingStorage();
		await storage.putRow("todos", "t1", {
			table: "todos",
			rowId: "t1",
			data: { id: "t1" },
			colClocks: {},
			serverHlc: null,
		});

		const { client } = makeClient(storage);
		await client.init();

		expect(storage.allRowsCalls).toBe(1);
		expect(client.getRows("todos").length).toBe(1);
		await client.close();
	});

	test("hydrateAllTables forces the full read", async () => {
		const storage = countingStorage();
		await storage.putRow("archive", "a1", {
			table: "archive",
			rowId: "a1",
			data: { id: "a1" },
			colClocks: {},
			serverHlc: null,
		});
		await storage.setMeta("syncSubscriptions", JSON.stringify([{ table: "todos" }]));

		const client = new SyncClient({
			clientId: "test-client",
			transport: createMockTransport(),
			token: "valid-token",
			storage,
			hydrateAllTables: true,
		});
		await client.init();

		expect(storage.allRowsCalls).toBe(1);
		expect(client.getRows("archive").length).toBe(1);
		await client.close();
	});
});
