import { describe, expect, test } from "bun:test";
import { createServer } from "../../src/server/server.ts";
import { createMockTransport } from "./helpers.ts";
import { packHlc } from "../../src/core/hlc.ts";
import { MAX_CLOCK_DRIFT_MS, PROTOCOL_VERSION } from "../../src/core/types.ts";
import type { ServerMessage } from "../../src/core/types.ts";
import type { ResolvedOp } from "../../src/server/types.ts";

async function tick(ms = 10): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function connectClient(
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
): Promise<void> {
	transport.connectHandler!(clientId, new Request("https://sync"));
	transport.messageHandler!(clientId, {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		clientId,
		token: "valid",
	});
	await tick();
}

function rejectFor(
	transport: ReturnType<typeof createMockTransport>,
	clientId: string,
): Extract<ServerMessage, { type: "reject" }> | undefined {
	return transport.sentMessages.find(
		(m) => m.clientId === clientId && m.message.type === "reject",
	)?.message as Extract<ServerMessage, { type: "reject" }> | undefined;
}

/**
 * Both eager modes bypass the conflict pipeline. They must NOT bypass the
 * enforcement gates that pipeline also happened to run — otherwise a client
 * can write fields the schema declares server-controlled.
 */
for (const broadcast of ["eager", "eager-durable"] as const) {
	describe(`${broadcast} broadcast enforcement`, () => {
		function setup() {
			const transport = createMockTransport();
			const applied: ResolvedOp[] = [];
			const server = createServer({ db: {}, transport });
			server.auth(async () => ({ userId: "u1", orgId: "acme" }));
			server.query("posts", () => Promise.resolve([]), {
				tables: ["posts"],
				broadcast,
				readonly: ["authorId"],
				serverSet: { orgId: (ctx: { auth: { orgId: string } }) => ctx.auth.orgId },
				mutate: async (op) => {
					applied.push(op);
				},
			});
			return { transport, applied, server };
		}

		test("strips readonly fields on update", async () => {
			const { transport, applied, server } = setup();
			await connectClient(transport, "c1");
			transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
			await tick();

			transport.messageHandler!("c1", {
				type: "ops",
				token: "valid",
				ops: [
					{
						id: "op-1",
						table: "posts",
						op: "update",
						rowId: "r1",
						payload: { title: "mine", authorId: "someone-else" },
						hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:c1" }),
					},
				],
			});
			await tick(20);

			expect(applied.length).toBe(1);
			expect(applied[0]!.payload).not.toHaveProperty("authorId");
			expect(applied[0]!.payload).toMatchObject({ title: "mine" });
			await server.close();
		});

		test("injects serverSet fields the client cannot forge", async () => {
			const { transport, applied, server } = setup();
			await connectClient(transport, "c1");
			transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
			await tick();

			transport.messageHandler!("c1", {
				type: "ops",
				token: "valid",
				ops: [
					{
						id: "op-1",
						table: "posts",
						op: "insert",
						rowId: "r1",
						payload: { title: "x", orgId: "victim-org" },
						hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:c1" }),
					},
				],
			});
			await tick(20);

			expect(applied[0]!.payload).toMatchObject({ orgId: "acme" });
			await server.close();
		});

		test("rejects ops whose clock is beyond the drift ceiling", async () => {
			const { transport, applied, server } = setup();
			await connectClient(transport, "c1");
			transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
			await tick();

			transport.messageHandler!("c1", {
				type: "ops",
				token: "valid",
				ops: [
					{
						id: "op-1",
						table: "posts",
						op: "insert",
						rowId: "r1",
						payload: { title: "from the future" },
						hlc: packHlc({
							ms: Date.now() + MAX_CLOCK_DRIFT_MS * 2,
							counter: 0,
							nodeId: "client:c1",
						}),
					},
				],
			});
			await tick(20);

			expect(applied.length).toBe(0);
			expect(rejectFor(transport, "c1")?.reason).toBe("clock_drift");
			await server.close();
		});

		test("rejects a batch larger than the cap", async () => {
			const { transport, applied, server } = setup();
			await connectClient(transport, "c1");
			transport.messageHandler!("c1", { type: "sync_declare", table: "posts" });
			await tick();

			transport.messageHandler!("c1", {
				type: "ops",
				token: "valid",
				ops: [
					{
						id: "op-1",
						table: "posts",
						op: "insert",
						rowId: "r1",
						payload: { title: "x" },
						hlc: packHlc({ ms: Date.now(), counter: 0, nodeId: "client:c1" }),
						batchId: "b1",
						batchSize: 10_000,
						batchSeq: 0,
					},
				],
			});
			await tick(20);

			expect(applied.length).toBe(0);
			expect(rejectFor(transport, "c1")?.reason).toBe("batch_too_large");
			await server.close();
		});
	});
}

describe("buffer_full", () => {
	test("is a member of the protocol's ErrorReason union", async () => {
		const { isErrorReason } = await import("../../src/core/types.ts");
		// Clients validate reasons against this set before surfacing onError;
		// a reason outside it would be silently dropped.
		expect(isErrorReason("buffer_full")).toBe(true);
	});
});
