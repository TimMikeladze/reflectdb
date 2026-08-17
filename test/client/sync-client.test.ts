import { describe, expect, test } from "bun:test";
import { SyncClient } from "../../src/client/sync-client.ts";
import type {
	ClientMessage,
	ServerMessage,
	ClientTransport,
	HelloMessage,
	SyncDeclareMessage,
	LoadMoreMessage,
	OpsMessage,
	AuthMessage,
	ResumeMessage,
} from "../../src/core/types.ts";
import { PROTOCOL_VERSION } from "../../src/core/types.ts";
import { packHlc } from "../../src/core/hlc.ts";

function createMockClientTransport(): ClientTransport & {
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

function setupClient(overrides: Partial<Parameters<typeof SyncClient.prototype.connect>[0]> = {}) {
	const transport = createMockClientTransport();
	const syncEvents: string[] = [];
	const errors: Array<{ opId?: string; reason: string }> = [];

	const client = new SyncClient({
		clientId: "test-client",
		transport,
		token: "valid-token",
		onSync: (table) => syncEvents.push(table),
		onError: (err) => errors.push(err),
	});

	return { client, transport, syncEvents, errors };
}

/** Connect and wait for hello_ack (standard test setup) */
async function connectClient(
	client: SyncClient,
	transport: ReturnType<typeof createMockClientTransport>,
) {
	const connectPromise = client.connect();
	transport.simulateMessage({
		type: "hello_ack",
		protocolVersion: PROTOCOL_VERSION,
		serverId: "test-srv",
	});
	await connectPromise;
}

describe("SyncClient - Connection", () => {
	test("connect sends hello message", () => {
		const { client, transport } = setupClient();
		// Don't await — we want to check state before ack
		client.connect();

		expect(transport.sentMessages.length).toBe(1);
		const hello = transport.sentMessages[0] as HelloMessage;
		expect(hello.type).toBe("hello");
		expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(hello.clientId).toBe("test-client");
		expect(client.getState()).toBe("connecting");
	});

	test("hello_ack transitions to connected", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);
		expect(client.getState()).toBe("connected");
	});

	test("hello_reject transitions to disconnected", async () => {
		const { client, transport, errors } = setupClient();

		const connectPromise = client.connect().catch(() => {});
		transport.simulateMessage({
			type: "hello_reject",
			reason: "bad token",
			supported: [PROTOCOL_VERSION],
		});
		await connectPromise;

		expect(client.getState()).toBe("disconnected");
		expect(errors.length).toBe(1);
		expect(errors[0]!.reason).toBe("local:hello_rejected");
		expect(errors[0]!.message).toBe("bad token");
	});

	test("close transitions to disconnected", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);
		await client.close();
		expect(client.getState()).toBe("disconnected");
	});
});

describe("SyncClient - Sync Control", () => {
	test("sync sends sync_declare", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);
		transport.sentMessages.length = 0;

		await client.sync("posts", { orgId: "org-1" });

		expect(transport.sentMessages.length).toBe(1);
		const syncDeclare = transport.sentMessages[0] as SyncDeclareMessage;
		expect(syncDeclare.type).toBe("sync_declare");
		expect(syncDeclare.table).toBe("posts");
		expect(syncDeclare.params).toEqual({ orgId: "org-1" });
	});

	test("unsync sends unsync and clears local data", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		// Add some local data
		client.insert("posts", "r1", { title: "hello" });
		expect(client.getRows("posts").length).toBe(1);

		transport.sentMessages.length = 0;
		await client.unsync("posts");

		expect(transport.sentMessages[0]!.type).toBe("unsync");
		expect(client.getRows("posts").length).toBe(0);
	});

	test("bootstrap sends bootstrap message", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);
		transport.sentMessages.length = 0;

		await client.bootstrap();

		expect(client.getState()).toBe("bootstrapping");
		expect(transport.sentMessages[0]!.type).toBe("bootstrap");
	});
});

describe("SyncClient - Data Operations", () => {
	test("insert creates op and applies optimistically", () => {
		const { client } = setupClient();
		const op = client.insert("posts", "r1", { title: "hello" });

		expect(op.table).toBe("posts");
		expect(op.op).toBe("insert");
		expect(client.getRow("posts", "r1")).toEqual({ id: "r1", title: "hello" });
		expect(client.getPendingCount()).toBe(1);
	});

	test("update merges into existing row", () => {
		const { client } = setupClient();
		client.insert("posts", "r1", { title: "old", body: "keep" });
		client.update("posts", "r1", { title: "new" });

		expect(client.getRow("posts", "r1")).toEqual({ id: "r1", title: "new", body: "keep" });
		expect(client.getPendingCount()).toBe(2);
	});

	test("delete removes row locally", () => {
		const { client } = setupClient();
		client.insert("posts", "r1", { title: "hello" });
		client.delete("posts", "r1");

		expect(client.getRow("posts", "r1")).toBeNull();
		expect(client.getPendingCount()).toBe(2);
	});

	test("batch creates multiple ops with shared batchId", () => {
		const { client } = setupClient();
		const ops = client.batch([
			{ table: "posts", op: "insert", rowId: "r1", payload: { title: "a" } },
			{ table: "posts", op: "insert", rowId: "r2", payload: { title: "b" } },
		]);

		expect(ops.length).toBe(2);
		expect(ops[0]!.batchId).toBe(ops[1]!.batchId);
		expect(client.getRows("posts").length).toBe(2);
		expect(client.getPendingCount()).toBe(2);
	});
});

describe("SyncClient - Push", () => {
	test("push sends pending ops", async () => {
		const { client, transport } = setupClient();
		client.insert("posts", "r1", { title: "hello" });

		transport.sentMessages.length = 0;
		await client.push();

		expect(transport.sentMessages.length).toBe(1);
		const msg = transport.sentMessages[0] as OpsMessage;
		expect(msg.type).toBe("ops");
		expect(msg.ops.length).toBe(1);
		expect(msg.token).toBe("valid-token");
	});

	test("push does nothing when no pending ops", async () => {
		const { client, transport } = setupClient();
		transport.sentMessages.length = 0;
		await client.push();
		expect(transport.sentMessages.length).toBe(0);
	});
});

describe("SyncClient - Server Messages", () => {
	test("snapshot replaces local table data", () => {
		const { client, transport, syncEvents } = setupClient();

		transport.simulateMessage({
			type: "snapshot",
			table: "posts",
			rows: [
				{ id: "r1", title: "server-a" },
				{ id: "r2", title: "server-b" },
			],
			colClocks: {
				r1: { _row: packHlc({ ms: 1000, counter: 0, nodeId: "server:1" }) },
				r2: { _row: packHlc({ ms: 2000, counter: 0, nodeId: "server:1" }) },
			},
		});

		expect(client.getRows("posts").length).toBe(2);
		expect(syncEvents).toEqual(["posts"]);
	});

	test("bootstrap_complete sets table meta and state", () => {
		const { client, transport } = setupClient();

		transport.simulateMessage({
			type: "bootstrap_complete",
			serverHlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" }),
			tableMeta: {
				posts: { serverSet: ["orgId"], readonly: ["createdAt"] },
			},
		});

		expect(client.getState()).toBe("synced");
		const meta = client.getStore().getTableMeta("posts");
		expect(meta).toEqual({
			serverSet: ["orgId"],
			readonly: ["createdAt"],
			broadcast: "consistent",
			pk: "id",
		});
	});

	test("snapshot with non-id pk keys rows by the declared pk (server-authoritative)", () => {
		const { client, transport } = setupClient();

		// Matches real server ordering: snapshot arrives BEFORE bootstrap_complete.
		// Snapshot carries its own pk so applySnapshot doesn't depend on tableMeta
		// being set first.
		transport.simulateMessage({
			type: "snapshot",
			table: "userSettings",
			pk: "userId",
			rows: [
				{ userId: "u-1", theme: "dark", locale: "en-US" },
				{ userId: "u-2", theme: "light", locale: "fr-FR" },
			],
			colClocks: {
				"u-1": { _row: packHlc({ ms: 1000, counter: 0, nodeId: "server:1" }) },
				"u-2": { _row: packHlc({ ms: 2000, counter: 0, nodeId: "server:1" }) },
			},
		});

		transport.simulateMessage({
			type: "bootstrap_complete",
			serverHlc: packHlc({ ms: 3000, counter: 0, nodeId: "server:1" }),
			tableMeta: {
				userSettings: {
					serverSet: [],
					readonly: [],
					broadcast: "consistent",
					pk: "userId",
				},
			},
		});

		// The bug: without pk in the snapshot message, applySnapshot runs before
		// tableMeta is set and falls back to "id" — collapsing all rows under "".
		expect(client.getRow("userSettings", "u-1")).toEqual({
			userId: "u-1",
			theme: "dark",
			locale: "en-US",
		});
		expect(client.getRow("userSettings", "u-2")).toEqual({
			userId: "u-2",
			theme: "light",
			locale: "fr-FR",
		});
		expect(client.getRows("userSettings")).toHaveLength(2);
	});

	test("snapshot falls back to tableMeta pk when message omits pk (older server compat)", () => {
		const { client, transport } = setupClient();

		// First set tableMeta so the lookup has something to fall back to.
		transport.simulateMessage({
			type: "bootstrap_complete",
			serverHlc: packHlc({ ms: 1000, counter: 0, nodeId: "server:1" }),
			tableMeta: {
				userSettings: {
					serverSet: [],
					readonly: [],
					broadcast: "consistent",
					pk: "userId",
				},
			},
		});

		// Now send a snapshot without pk — should use tableMeta.pk
		transport.simulateMessage({
			type: "snapshot",
			table: "userSettings",
			rows: [{ userId: "u-1", theme: "dark", locale: "en-US" }],
			colClocks: {
				"u-1": { _row: packHlc({ ms: 2000, counter: 0, nodeId: "server:1" }) },
			},
		});

		expect(client.getRow("userSettings", "u-1")).toEqual({
			userId: "u-1",
			theme: "dark",
			locale: "en-US",
		});
	});

	test("delta insert adds row", () => {
		const { client, transport, syncEvents } = setupClient();

		transport.simulateMessage({
			type: "delta",
			table: "posts",
			op: "insert",
			rowId: "r1",
			payload: { title: "delta-insert" },
			hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" }),
		});

		expect(client.getRow("posts", "r1")).toEqual({ id: "r1", title: "delta-insert" });
		expect(syncEvents).toEqual(["posts"]);
	});

	test("delta update merges into existing", () => {
		const { client, transport } = setupClient();
		client.insert("posts", "r1", { title: "old", body: "keep" });

		transport.simulateMessage({
			type: "delta",
			table: "posts",
			op: "update",
			rowId: "r1",
			payload: { title: "server-new" },
			hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" }),
			colClocks: {
				title: packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" }),
			},
		});

		expect(client.getRow("posts", "r1")).toEqual({ id: "r1", title: "server-new", body: "keep" });
	});

	test("delta delete removes row", () => {
		const { client, transport } = setupClient();
		client.insert("posts", "r1", { title: "doomed" });

		transport.simulateMessage({
			type: "delta",
			table: "posts",
			op: "delete",
			rowId: "r1",
			payload: null,
			hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" }),
		});

		expect(client.getRow("posts", "r1")).toBeNull();
	});

	test("ack removes pending ops", () => {
		const { client, transport } = setupClient();
		const op = client.insert("posts", "r1", { title: "hello" });

		expect(client.getPendingCount()).toBe(1);

		transport.simulateMessage({
			type: "ack",
			opIds: [op.id],
		});

		expect(client.getPendingCount()).toBe(0);
	});

	test("reject reverts optimistic change", () => {
		const { client, transport, errors } = setupClient();
		const op = client.insert("posts", "r1", { title: "optimistic" });

		transport.simulateMessage({
			type: "reject",
			opId: op.id,
			reason: "server_conflict",
			serverRow: { title: "server-truth" },
		});

		// Row should be reverted to server state
		expect(client.getRow("posts", "r1")).toEqual({ title: "server-truth" });
		expect(client.getPendingCount()).toBe(0);
		expect(errors[0]!.reason).toBe("server_conflict");
	});

	test("reject with null serverRow deletes row", () => {
		const { client, transport } = setupClient();
		const op = client.insert("posts", "r1", { title: "ghost" });

		transport.simulateMessage({
			type: "reject",
			opId: op.id,
			reason: "outside_shape",
		});

		expect(client.getRow("posts", "r1")).toBeNull();
	});

	test("batch reject reverts every op in the batch", () => {
		const { client, transport } = setupClient();
		const ops = client.batch([
			{ table: "posts", op: "insert", rowId: "r1", payload: { title: "a" } },
			{ table: "posts", op: "insert", rowId: "r2", payload: { title: "b" } },
		]);
		expect(client.getRow("posts", "r1")).toEqual({ id: "r1", title: "a" });
		expect(client.getRow("posts", "r2")).toEqual({ id: "r2", title: "b" });

		const batchId = ops[0]!.batchId!;
		transport.simulateMessage({
			type: "reject",
			batchId,
			reason: "outside_shape",
		});

		expect(client.getRow("posts", "r1")).toBeNull();
		expect(client.getRow("posts", "r2")).toBeNull();
		expect(client.getPendingCount()).toBe(0);
	});

	test("reauth triggers token refresh callback", async () => {
		let reauthCalled = false;
		const transport = createMockClientTransport();
		const client = new SyncClient({
			clientId: "test",
			transport,
			token: "old-token",
			onReauth: async () => {
				reauthCalled = true;
				return "new-token";
			},
		});

		transport.simulateMessage({ type: "reauth" });
		await new Promise((r) => setTimeout(r, 10));

		expect(reauthCalled).toBe(true);
		// Should have sent auth message with new token
		const authMsg = transport.sentMessages.find((m) => m.type === "auth") as
			| AuthMessage
			| undefined;
		expect(authMsg).toBeDefined();
		expect(authMsg!.token).toBe("new-token");
	});

	test("disconnect sets state and fires error", () => {
		const { client, transport, errors } = setupClient();

		transport.simulateMessage({
			type: "disconnect",
			reason: "server shutdown",
		});

		expect(client.getState()).toBe("disconnected");
		expect(errors[0]!.reason).toBe("local:disconnected");
		expect(errors[0]!.message).toBe("server shutdown");
	});

	test("shape_changed clears table and notifies", () => {
		const { client, transport, syncEvents } = setupClient();
		client.insert("posts", "r1", { title: "old" });

		transport.simulateMessage({
			type: "shape_changed",
			table: "posts",
			reason: "auth_changed",
		});

		expect(client.getRows("posts").length).toBe(0);
		expect(syncEvents).toContain("posts");
	});
});

describe("SyncClient - Resume", () => {
	test("resume with no serverHlc falls back to bootstrap", async () => {
		const { client, transport } = setupClient();
		transport.sentMessages.length = 0;

		await client.resume();

		expect(transport.sentMessages[0]!.type).toBe("bootstrap");
	});

	test("resume with serverHlc sends resume message", async () => {
		const { client, transport } = setupClient();

		// Simulate a prior bootstrap
		const hlc = packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" });
		transport.simulateMessage({
			type: "bootstrap_complete",
			serverHlc: hlc,
			tableMeta: {},
		});

		transport.sentMessages.length = 0;
		await client.resume();

		const resumeMsg = transport.sentMessages[0] as ResumeMessage;
		expect(resumeMsg.type).toBe("resume");
		expect(resumeMsg.since).toBe(hlc);
	});

	test("resume_complete updates state", () => {
		const { client, transport } = setupClient();

		transport.simulateMessage({
			type: "resume_complete",
			serverHlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" }),
		});

		expect(client.getState()).toBe("synced");
	});
});

describe("SyncClient - Subscribe / Notify", () => {
	test("subscribe is called on insert", () => {
		const { client } = setupClient();
		let callCount = 0;
		client.subscribe(() => {
			callCount++;
		});

		client.insert("posts", "r1", { title: "hello" });
		expect(callCount).toBe(1);
	});

	test("subscribe is called on server messages", () => {
		const { client, transport } = setupClient();
		let callCount = 0;
		client.subscribe(() => {
			callCount++;
		});

		transport.simulateMessage({
			type: "delta",
			table: "posts",
			op: "insert",
			rowId: "r1",
			payload: { title: "from server" },
			hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "server:1" }),
		});

		expect(callCount).toBe(1);
	});

	test("unsubscribe stops notifications", () => {
		const { client } = setupClient();
		let callCount = 0;
		const unsub = client.subscribe(() => {
			callCount++;
		});

		client.insert("posts", "r1", { title: "first" });
		expect(callCount).toBe(1);

		unsub();
		client.insert("posts", "r2", { title: "second" });
		expect(callCount).toBe(1);
	});

	test("getVersion increments on changes", () => {
		const { client } = setupClient();
		const v0 = client.getVersion();

		client.insert("posts", "r1", { title: "hello" });
		expect(client.getVersion()).toBe(v0 + 1);

		client.update("posts", "r1", { title: "updated" });
		expect(client.getVersion()).toBe(v0 + 2);
	});
});

describe("SyncClient - Windowed Sync", () => {
	test("sync with window sends sync_declare with window", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);
		transport.sentMessages.length = 0;

		await client.sync("posts", { orgId: "org-1" }, { window: 50 });

		const msg = transport.sentMessages[0] as SyncDeclareMessage;
		expect(msg.type).toBe("sync_declare");
		expect(msg.window).toBe(50);
		expect(msg.params).toEqual({ orgId: "org-1" });
	});

	test("sync without window sends no window field", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);
		transport.sentMessages.length = 0;

		await client.sync("posts", { orgId: "org-1" });

		const msg = transport.sentMessages[0] as SyncDeclareMessage;
		expect(msg.window).toBeUndefined();
	});

	test("loadMore sends load_more message", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);
		await client.sync("posts", {}, { window: 10 });
		transport.sentMessages.length = 0;

		await client.loadMore("posts", 20);

		const msg = transport.sentMessages[0] as LoadMoreMessage;
		expect(msg.type).toBe("load_more");
		expect(msg.table).toBe("posts");
		expect(msg.count).toBe(20);
	});

	test("snapshot with totalCount stores total count", () => {
		const { client, transport } = setupClient();

		transport.simulateMessage({
			type: "snapshot",
			table: "posts",
			rows: [
				{ id: "r1", title: "a" },
				{ id: "r2", title: "b" },
			],
			colClocks: {},
			totalCount: 100,
		});

		expect(client.getRows("posts")).toHaveLength(2);
		expect(client.getTotalCount("posts")).toBe(100);
	});

	test("snapshot without totalCount returns null for getTotalCount", () => {
		const { client, transport } = setupClient();

		transport.simulateMessage({
			type: "snapshot",
			table: "posts",
			rows: [{ id: "r1", title: "a" }],
			colClocks: {},
		});

		expect(client.getTotalCount("posts")).toBeNull();
	});

	test("appending snapshot adds rows without clearing", () => {
		const { client, transport } = setupClient();

		// Initial snapshot
		transport.simulateMessage({
			type: "snapshot",
			table: "posts",
			rows: [
				{ id: "r1", title: "first" },
				{ id: "r2", title: "second" },
			],
			colClocks: {},
			totalCount: 5,
		});

		expect(client.getRows("posts")).toHaveLength(2);

		// Appending snapshot (from loadMore)
		transport.simulateMessage({
			type: "snapshot",
			table: "posts",
			rows: [
				{ id: "r3", title: "third" },
				{ id: "r4", title: "fourth" },
			],
			colClocks: {},
			append: true,
		});

		expect(client.getRows("posts")).toHaveLength(4);
		expect(client.getRow("posts", "r1")?.title).toBe("first");
		expect(client.getRow("posts", "r3")?.title).toBe("third");
	});

	test("non-appending snapshot clears existing rows", () => {
		const { client, transport } = setupClient();

		transport.simulateMessage({
			type: "snapshot",
			table: "posts",
			rows: [{ id: "r1", title: "old" }],
			colClocks: {},
		});

		transport.simulateMessage({
			type: "snapshot",
			table: "posts",
			rows: [{ id: "r2", title: "new" }],
			colClocks: {},
		});

		expect(client.getRows("posts")).toHaveLength(1);
		expect(client.getRow("posts", "r1")).toBeNull();
		expect(client.getRow("posts", "r2")?.title).toBe("new");
	});

	test("count_changed updates totalCount and notifies", () => {
		const { client, transport } = setupClient();
		let notified = false;
		client.subscribe(() => {
			notified = true;
		});

		transport.simulateMessage({
			type: "count_changed",
			table: "posts",
			totalCount: 42,
		});

		expect(client.getTotalCount("posts")).toBe(42);
		expect(notified).toBe(true);
	});

	test("unsync clears totalCount and syncOptions", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		await client.sync("posts", {}, { window: 10 });

		transport.simulateMessage({
			type: "snapshot",
			table: "posts",
			rows: [{ id: "r1", title: "a" }],
			colClocks: {},
			totalCount: 50,
		});

		expect(client.getTotalCount("posts")).toBe(50);

		await client.unsync("posts");

		expect(client.getTotalCount("posts")).toBeNull();
		expect(client.getRows("posts")).toHaveLength(0);
	});
});

describe("SyncClient - Per-table notifications", () => {
	test("table-specific listeners only fire for their table", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		const postsCalls: number[] = [];
		const commentsCalls: number[] = [];

		client.subscribeTable("posts", () => postsCalls.push(1));
		client.subscribeTable("comments", () => commentsCalls.push(1));

		// Insert into posts — only posts listener fires
		client.insert("posts", "p1", { title: "hello" });
		expect(postsCalls.length).toBe(1);
		expect(commentsCalls.length).toBe(0);

		// Delta on comments — only comments listener fires
		transport.simulateMessage({
			type: "delta",
			table: "comments",
			op: "insert",
			rowId: "c1",
			payload: { text: "hi" },
			hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "server:test" }),
		});
		expect(postsCalls.length).toBe(1);
		expect(commentsCalls.length).toBe(1);
	});

	test("global listeners fire on all changes", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		const globalCalls: number[] = [];
		client.subscribe(() => globalCalls.push(1));

		client.insert("posts", "p1", { title: "a" });
		client.insert("comments", "c1", { text: "b" });
		expect(globalCalls.length).toBe(2);
	});

	test("getTableVersion increments only for affected table", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		const v0Posts = client.getTableVersion("posts");
		const v0Comments = client.getTableVersion("comments");

		client.insert("posts", "p1", { title: "hello" });

		expect(client.getTableVersion("posts")).toBe(v0Posts + 1);
		expect(client.getTableVersion("comments")).toBe(v0Comments);
	});

	test("ack resolves affected tables and notifies per-table", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		const postsCalls: number[] = [];
		client.subscribeTable("posts", () => postsCalls.push(1));

		const op = client.insert("posts", "p1", { title: "hello" });
		const callsAfterInsert = postsCalls.length;

		transport.simulateMessage({
			type: "ack",
			opIds: [op.id],
		});

		expect(postsCalls.length).toBeGreaterThan(callsAfterInsert);
	});

	test("batch notifies all affected tables", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		const postsCalls: number[] = [];
		const commentsCalls: number[] = [];
		client.subscribeTable("posts", () => postsCalls.push(1));
		client.subscribeTable("comments", () => commentsCalls.push(1));

		client.batch([
			{ table: "posts", op: "insert", rowId: "p1", payload: { title: "a" } },
			{ table: "comments", op: "insert", rowId: "c1", payload: { text: "b" } },
		]);

		expect(postsCalls.length).toBe(1);
		expect(commentsCalls.length).toBe(1);
	});

	test("unsubscribeTable cleans up listeners", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		const calls: number[] = [];
		const unsub = client.subscribeTable("posts", () => calls.push(1));

		client.insert("posts", "p1", { title: "a" });
		expect(calls.length).toBe(1);

		unsub();
		client.insert("posts", "p2", { title: "b" });
		expect(calls.length).toBe(1); // No additional call
	});
});

describe("SyncClient - resume_rejected", () => {
	test("falls back to bootstrap on resume_rejected", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);
		await client.sync("posts");

		// Simulate having a serverHlc so resume() sends a resume message
		transport.simulateMessage({
			type: "bootstrap_complete",
			serverHlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "server:test" }),
			tableMeta: {},
		});

		transport.sentMessages.length = 0;

		// Simulate resume_rejected — should trigger bootstrap
		transport.simulateMessage({
			type: "resume_rejected",
			reason: "compacted",
			serverHlc: packHlc({ ms: Date.now(), counter: 1, nodeId: "server:test" }),
		});

		const bootstrapMsg = transport.sentMessages.find((m) => m.type === "bootstrap");
		expect(bootstrapMsg).toBeDefined();
	});
});

describe("SyncClient - Reconnection", () => {
	test("schedules reconnect on disconnect message", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		transport.simulateMessage({
			type: "disconnect",
			reason: "server_shutdown",
		});

		expect(client.getState()).toBe("disconnected");
		// Reconnect is scheduled (we verify by checking that close prevents it)
	});

	test("close cancels pending reconnect", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		transport.simulateMessage({
			type: "disconnect",
			reason: "server_shutdown",
		});

		// Close should cancel the reconnect timer
		await client.close();
		expect(client.getState()).toBe("disconnected");
	});

	test("reconnect delay applies full jitter (range [base/2, base])", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);

		const capturedDelays: number[] = [];
		const origSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms?: number) => {
			if (typeof ms === "number" && ms > 0 && ms < 60000) {
				capturedDelays.push(ms);
			}
			return origSetTimeout(fn, ms);
		}) as typeof setTimeout;

		const origRandom = Math.random;
		try {
			// Pin Math.random=0 → delay = base * 0.5
			Math.random = () => 0;
			transport.simulateMessage({ type: "disconnect", reason: "test" });
			await new Promise<void>((r) => origSetTimeout(r, 10));
			expect(capturedDelays.at(-1)).toBe(500);

			await client.close();
		} finally {
			Math.random = origRandom;
			globalThis.setTimeout = origSetTimeout;
		}

		// Second client: Math.random=0.999 → delay ≈ base
		const c2 = setupClient();
		await connectClient(c2.client, c2.transport);
		const delays2: number[] = [];
		const orig2 = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms?: number) => {
			if (typeof ms === "number" && ms > 0 && ms < 60000) delays2.push(ms);
			return orig2(fn, ms);
		}) as typeof setTimeout;
		const r2 = Math.random;
		try {
			Math.random = () => 0.999999;
			c2.transport.simulateMessage({ type: "disconnect", reason: "test" });
			await new Promise<void>((r) => orig2(r, 10));
			expect(delays2.at(-1)).toBe(1000);
			await c2.client.close();
		} finally {
			Math.random = r2;
			globalThis.setTimeout = orig2;
		}
	});

	test("reconnect resends hello and re-subscribes tables", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);
		await client.sync("posts");
		await client.sync("comments");

		transport.sentMessages.length = 0;

		// Auto-respond to hello with hello_ack so reconnect completes
		const origSend = transport.send.bind(transport);
		transport.send = async (message: ClientMessage) => {
			await origSend(message);
			if (message.type === "hello") {
				// Respond asynchronously like a real server
				queueMicrotask(() => {
					transport.simulateMessage({
						type: "hello_ack",
						protocolVersion: PROTOCOL_VERSION,
						serverId: "test-srv",
					});
				});
			}
		};

		// Trigger disconnect → reconnect (1s delay)
		transport.simulateMessage({
			type: "disconnect",
			reason: "test",
		});

		// Wait for reconnect timer (1s) + async processing
		await new Promise<void>((r) => setTimeout(r, 1200));

		// Should have sent: hello, sync_declare(posts), sync_declare(comments), resume/bootstrap
		const hello = transport.sentMessages.find((m) => m.type === "hello");
		expect(hello).toBeDefined();

		const syncDeclares = transport.sentMessages.filter(
			(m) => m.type === "sync_declare",
		) as SyncDeclareMessage[];
		const syncedNames = syncDeclares.map((m) => m.table).sort();
		expect(syncedNames).toEqual(["comments", "posts"]);
	});
});

describe("SyncClient - connect() rejection on disconnect", () => {
	test("connect rejects if transport closes before hello_ack", async () => {
		const { client, transport } = setupClient();

		const connectPromise = client.connect();

		// Transport dies before hello_ack arrives
		transport.simulateMessage({
			type: "disconnect",
			reason: "transport_closed",
		});

		await expect(connectPromise).rejects.toThrow("transport_closed");
	});
});

describe("SyncClient - handleReauth error handling", () => {
	test("reauth failure reports error via onError", async () => {
		const errors: Array<{ opId?: string; reason: string }> = [];
		const transport = createMockClientTransport();
		const client = new SyncClient({
			clientId: "test",
			transport,
			token: "tok",
			onReauth: async () => {
				throw new Error("token refresh failed");
			},
			onError: (err) => errors.push(err),
		});

		await connectClient(client, transport);
		transport.simulateMessage({ type: "reauth" });

		// Wait for async reauth to settle
		await new Promise<void>((r) => setTimeout(r, 50));

		expect(errors.some((e) => e.reason === "local:reauth_failed")).toBe(true);
	});

	test("push chunks pendingOps into MAX_BATCH_SIZE batches", async () => {
		const { client, transport } = setupClient();
		await connectClient(client, transport);
		transport.sentMessages.length = 0;

		// Insert 250 ops; server batch cap is 100 → expect 3 ops messages.
		for (let i = 0; i < 250; i++) {
			client.insert("posts", { id: `r${i}`, title: `t${i}` });
		}
		await client.push();

		const opsMessages = transport.sentMessages.filter((m) => m.type === "ops") as OpsMessage[];
		expect(opsMessages.length).toBe(3);
		expect(opsMessages[0]!.ops.length).toBe(100);
		expect(opsMessages[1]!.ops.length).toBe(100);
		expect(opsMessages[2]!.ops.length).toBe(50);
	});
});
