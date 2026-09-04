import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { positionBetween, sortCards, type Card } from "./schema.ts";
import { boardIdFrom, closeBoard, createBoard, createKanbanDriver, openBoard } from "./lib/board.ts";
import { RESET_INTERVAL_MS, SEED_CARDS, resetIfDue, resetWindow } from "./lib/reset.ts";
import { POST } from "./api/sync/messages.ts";
import { GET } from "./api/sync/events.ts";
import type { ClientMessage, ServerMessage } from "../../src/core/types.ts";

/**
 * Drives the REAL Vercel handlers, so the wiring the example exists to
 * demonstrate is what is under test — not a reimplementation of it.
 *
 * `KANBAN_LOCAL_DIR` points the board at the filesystem driver, which has the
 * same CAS semantics as a bucket, so no credentials are needed.
 */

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "kanban-"));
	roots.push(root);
	process.env.KANBAN_LOCAL_DIR = root;
});

/**
 * Rows a visitor actually added, with the seed cards the five-minute reset
 * writes filtered out. Every board is seeded on first contact now, so an
 * assertion about "what this test put there" has to say so explicitly.
 */
function authored(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
	const seeded = new Set(SEED_CARDS.map((card) => card.id));
	return rows.filter((row) => !seeded.has(String(row.id)));
}

/** One POST, exactly as the browser makes it. */
async function post(
	clientId: string,
	message: ClientMessage,
	board = "test",
): Promise<ServerMessage[]> {
	const response = await POST(
		new Request(
			`https://example.invalid/api/sync/messages?board=${board}&clientId=${clientId}`,
			{ method: "POST", body: JSON.stringify(message) },
		),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { messages: ServerMessage[] };
	return body.messages;
}

async function connect(clientId: string, board = "test"): Promise<void> {
	const hello = await post(
		clientId,
		{ type: "hello", clientId, token: "anonymous", protocolVersion: 1 } as ClientMessage,
		board,
	);
	expect(hello.map((m) => m.type)).toContain("hello_ack");
	await post(clientId, { type: "sync_declare", table: "cards" } as ClientMessage, board);
}

describe("kanban board", () => {
	test("a card added through the POST endpoint is durable and readable", async () => {
		await connect("alice");

		const acks = await post("alice", {
			type: "ops",
			token: "anonymous",
			ops: [
				{
					id: crypto.randomUUID(),
					table: "cards",
					op: "insert",
					rowId: "c1",
					payload: { title: "Write the README", column: "todo", position: 0 },
					hlc: "0000000000000000001.0000.client:alice",
				},
			],
		} as unknown as ClientMessage);
		expect(acks.map((m) => m.type)).toContain("ack");

		// A SEPARATE invocation — nothing shared but the directory standing in for
		// the bucket — must see it. That is the whole claim of the example.
		await connect("bob");
		const bootstrap = await post("bob", { type: "bootstrap" } as ClientMessage);
		const snapshot = bootstrap.find(
			(m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot",
		);
		expect(authored(snapshot!.rows)).toHaveLength(1);
		expect(authored(snapshot!.rows)[0]).toMatchObject({
			title: "Write the README",
			column: "todo",
		});
	});

	test("an unknown column is refused, not coerced or stored", async () => {
		await connect("alice");
		await post("alice", {
			type: "ops",
			token: "anonymous",
			ops: [
				{
					id: crypto.randomUUID(),
					table: "cards",
					op: "insert",
					rowId: "c1",
					payload: { title: "sneaky", column: "../../etc", position: 0 },
					hlc: "0000000000000000001.0000.client:alice",
				},
			],
		} as unknown as ClientMessage);

		const bootstrap = await post("alice", { type: "bootstrap" } as ClientMessage);
		const snapshot = bootstrap.find(
			(m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot",
		);
		// Refused outright. Coercing would be worse: it would move someone's card
		// to a column they did not choose, and leave the raw value in the mirror
		// that conflict resolution compares against.
		expect(authored(snapshot!.rows)).toHaveLength(0);
	});

	test("boards are isolated from each other", async () => {
		await connect("alice", "alpha");
		await post(
			"alice",
			{
				type: "ops",
				token: "anonymous",
				ops: [
					{
						id: crypto.randomUUID(),
						table: "cards",
						op: "insert",
						rowId: "c1",
						payload: { title: "alpha card", column: "todo", position: 0 },
						hlc: "0000000000000000001.0000.client:alice",
					},
				],
			} as unknown as ClientMessage,
			"alpha",
		);

		await connect("bob", "beta");
		const bootstrap = await post("bob", { type: "bootstrap" } as ClientMessage, "beta");
		const snapshot = bootstrap.find(
			(m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot",
		);
		// Beta has only its own seed cards; alpha's card never crossed over.
		expect(authored(snapshot!.rows)).toHaveLength(0);
		expect(snapshot!.rows.some((r) => r.title === "alpha card")).toBe(false);
	});

	test("a malformed body is rejected without touching storage", async () => {
		const response = await POST(
			new Request("https://example.invalid/api/sync/messages?board=test&clientId=alice", {
				method: "POST",
				body: "{not json",
			}),
		);
		expect(response.status).toBe(400);
	});

	test("clientId is required", async () => {
		const response = await POST(
			new Request("https://example.invalid/api/sync/messages?board=test", {
				method: "POST",
				body: "{}",
			}),
		);
		expect(response.status).toBe(400);
	});
});

/**
 * Opens the real SSE stream and accumulates the frames it pushes.
 *
 * A single background pump owns the reader. Racing `reader.read()` against a
 * timeout instead would drop frames: the abandoned read still consumes the next
 * chunk, so the poll that finally delivers the delta is the one nobody is
 * holding.
 */
function openStream(clientId: string, board: string) {
	let text = "";
	const ready = GET(
		new Request(`https://example.invalid/api/sync/events?board=${board}&clientId=${clientId}`),
	).then((res) => {
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		const pump = (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return;
					text += decoder.decode(value, { stream: true });
				}
			} catch {
				/* cancelled */
			}
		})();
		return { reader, pump };
	});

	return {
		/** Everything received so far, waiting up to `budgetMs` for `match` to show up. */
		async read(match: string, budgetMs = 3000): Promise<string> {
			await ready;
			const deadline = Date.now() + budgetMs;
			while (!text.includes(match) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			return text;
		},
		async close(): Promise<void> {
			const { reader, pump } = await ready;
			await reader.cancel();
			await pump;
		},
	};
}

/** Adds one card to `board` through the real POST endpoint. */
/** Monotonic wall-clock HLC, matching what the browser client produces. */
let hlcCounter = 0;
function nextHlc(clientId: string): string {
	hlcCounter += 1;
	return `${String(Date.now()).padStart(19, "0")}.${String(hlcCounter).padStart(4, "0")}.client:${clientId}`;
}

async function addCard(clientId: string, rowId: string, title: string, board: string): Promise<void> {
	await post(
		clientId,
		{
			type: "ops",
			token: "anonymous",
			ops: [
				{
					id: crypto.randomUUID(),
					table: "cards",
					op: "insert",
					rowId,
					// `id` in the payload, exactly as the client sends it: the server
					// stores the resolved payload as the row and keys on `id`.
					payload: { id: rowId, title, column: "todo", position: 0 },
					// A wall-clock HLC, as a real client stamps. NOT a small synthetic
					// one: the seed cards the reset writes carry server HLCs, so an op
					// below them never moves the op-log head, `pollRemoteChanges` sees
					// no change, and the stream stays silent.
					hlc: nextHlc(clientId),
				},
			],
		} as unknown as ClientMessage,
		board,
	);
}

/** Every card currently on `board`, straight from storage. */
async function cardsOn(board: string): Promise<Card[]> {
	const built = createBoard(board);
	try {
		await built.storage.init();
		return (await built.storage.getRows("cards")).rows as unknown as Card[];
	} finally {
		await closeBoard(built);
	}
}

describe("the SSE stream", () => {
	test("pushes another client's card to an open tab", async () => {
		await connect("alice", "team-alpha");
		const stream = openStream("alice", "team-alpha");
		// Force the stream open before the write, so this exercises the live push
		// rather than the bootstrap snapshot.
		await stream.read("__never__", 300);

		await connect("bob", "team-alpha");
		await addCard("bob", "b1", "BOBS-CARD", "team-alpha");

		try {
			const got = await stream.read("BOBS-CARD");
			console.log("STREAM>>>", got.slice(0, 900));
			expect(got).toContain('"op":"insert"');
		} finally {
			await stream.close();
		}
	});

	test("pushes the reset performed by another invocation", async () => {
		await connect("alice", "demo");
		await addCard("alice", "graffiti", "left by a visitor", "demo");

		const stream = openStream("alice", "demo");
		await stream.read("__never__", 300);

		const other = createBoard("demo");
		try {
			expect(await resetIfDue(other, "demo", Date.now() + RESET_INTERVAL_MS)).toBe(true);
		} finally {
			await closeBoard(other);
		}

		try {
			// The tab is told the card is gone. Without this the reset would be
			// invisible to everyone already looking at the board.
			expect(await stream.read('"rowId":"graffiti"')).toContain('"op":"delete"');
		} finally {
			await stream.close();
		}
	});
});

describe("the demo board reset", () => {
	/** A time in a window nothing has claimed yet, so a direct call is not fighting the routes. */
	function laterWindow(intervals = 1): number {
		return Date.now() + intervals * RESET_INTERVAL_MS;
	}

	test("a visitor arriving in a new window is served the seed cards, not the last one's", async () => {
		// The POST route runs the reset itself, before it builds the snapshot.
		await connect("alice", "demo");
		const bootstrap = await post("alice", { type: "bootstrap" } as ClientMessage, "demo");
		const snapshot = bootstrap.find(
			(m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot",
		);
		expect((snapshot!.rows as unknown as Card[]).map((c) => c.id).sort()).toEqual(
			SEED_CARDS.map((c) => c.id).sort(),
		);
	});

	test("replaces whatever visitors left with the seed cards", async () => {
		await connect("alice", "demo");
		await addCard("alice", "graffiti", "left by a visitor", "demo");
		expect((await cardsOn("demo")).map((c) => c.id)).toContain("graffiti");

		const board = createBoard("demo");
		try {
			expect(await resetIfDue(board, "demo", laterWindow())).toBe(true);
		} finally {
			await closeBoard(board);
		}

		const ids = (await cardsOn("demo")).map((c) => c.id).sort();
		expect(ids).toEqual(SEED_CARDS.map((c) => c.id).sort());
	});

	test("runs once per window, however many instances race for it", async () => {
		await connect("alice", "demo");
		await addCard("alice", "graffiti", "left by a visitor", "demo");

		// Distinct boards, exactly like two Vercel invocations: nothing shared but
		// the store. Only the one that creates the claim key resets.
		const when = laterWindow();
		const instances = [createBoard("demo"), createBoard("demo")];
		try {
			const won = await Promise.all(
				instances.map((b) => resetIfDue(b, "demo", when)),
			);
			expect(won.filter(Boolean)).toHaveLength(1);
		} finally {
			for (const instance of instances) await closeBoard(instance);
		}
	});

	test("edits made between resets survive until the window rolls over", async () => {
		await connect("alice", "demo");
		await addCard("alice", "graffiti", "left by a visitor", "demo");

		// Same window as the reset the route already performed on connect, so this
		// call finds the claim taken and leaves the visitor's card alone.
		const board = createBoard("demo");
		try {
			expect(await resetIfDue(board, "demo")).toBe(false);
		} finally {
			await closeBoard(board);
		}
		expect((await cardsOn("demo")).map((c) => c.id)).toContain("graffiti");
	});

	/**
	 * Drops every claim marker for a board, which is what the store looks like
	 * one tick into a window that follows a reset: the board is pristine, and
	 * nothing has claimed the new window yet.
	 */
	async function forgetClaims(boardId: string): Promise<void> {
		const driver = createKanbanDriver();
		const keys = (await driver.list(`resets/${boardId}/`)).map((entry) => entry.key);
		if (keys.length > 0) await driver.delete(keys);
	}

	test("a second tab connecting does not undo the first tab's move", async () => {
		// The reported bug, driven through the real routes: one tab and one
		// incognito tab, and the card "always switches back".
		await connect("alice", "demo");
		await forgetClaims("demo");

		await addCard("alice", "moved", "alice moved this", "demo");

		// The second tab's handshake — three POSTs, each of which calls the reset.
		await connect("bob", "demo");
		await post("bob", { type: "bootstrap" } as ClientMessage, "demo");

		expect((await cardsOn("demo")).map((c) => c.id)).toContain("moved");
	});

	test("an edit made in a window that needed no reset is left alone", async () => {
		// The window nobody reset: the board came into it already pristine, so
		// there was nothing to do and — before this was fixed — nothing claimed the
		// window either. The first visitor edit then made the board dirty, and the
		// very next request claimed the window and wiped the edit. On the deployed
		// demo that is a card that snaps back the moment a second tab says
		// anything, which is what a visitor reported.
		await connect("alice", "demo");

		const when = laterWindow();
		const idle = createBoard("demo");
		try {
			// Pristine, so no reset happens — but the window must still be spent.
			expect(await resetIfDue(idle, "demo", when)).toBe(false);
		} finally {
			await closeBoard(idle);
		}

		await addCard("alice", "graffiti", "left by a visitor", "demo");

		const next = createBoard("demo");
		try {
			expect(await resetIfDue(next, "demo", when)).toBe(false);
		} finally {
			await closeBoard(next);
		}

		expect((await cardsOn("demo")).map((c) => c.id)).toContain("graffiti");
	});

	test("resets again once the clock rolls into the next window", async () => {
		await connect("alice", "demo");
		await addCard("alice", "first", "first window", "demo");

		const one = createBoard("demo");
		try {
			expect(await resetIfDue(one, "demo", laterWindow(1))).toBe(true);
		} finally {
			await closeBoard(one);
		}

		await addCard("alice", "second", "second window", "demo");

		const two = createBoard("demo");
		try {
			expect(await resetIfDue(two, "demo", laterWindow(2))).toBe(true);
		} finally {
			await closeBoard(two);
		}
		expect((await cardsOn("demo")).map((c) => c.id)).not.toContain("second");
	});

	test("is a no-op on a board that already holds exactly the seed cards", async () => {
		// The route seeded it on connect and nobody has touched it since, so a
		// later window has nothing to do — rewriting identical rows every five
		// minutes would grow the op log for no reason.
		await connect("alice", "demo");

		const board = createBoard("demo");
		try {
			expect(await resetIfDue(board, "demo", laterWindow(3))).toBe(false);
		} finally {
			await closeBoard(board);
		}
	});

	test("resets a board made with ?board=<slug> too — no board is exempt", async () => {
		// The demo is public and has no sign-in, so there is nowhere to put data
		// meant to last. A board that quietly kept its contents would invite people
		// to rely on storage this example does not offer.
		await connect("alice", "team-alpha");
		await addCard("alice", "theirs", "not a demo card", "team-alpha");

		const board = createBoard("team-alpha");
		try {
			expect(await resetIfDue(board, "team-alpha", laterWindow())).toBe(true);
		} finally {
			await closeBoard(board);
		}

		const ids = (await cardsOn("team-alpha")).map((c) => c.id).sort();
		expect(ids).toEqual(SEED_CARDS.map((c) => c.id).sort());
		expect(ids).not.toContain("theirs");
	});

	test("windows are the same number on every instance, and advance every interval", () => {
		expect(resetWindow(0)).toBe(0);
		expect(resetWindow(RESET_INTERVAL_MS - 1)).toBe(0);
		expect(resetWindow(RESET_INTERVAL_MS)).toBe(1);
	});
});

describe("an unbootable room", () => {
	test("is cleared and started over rather than answering 500 forever", async () => {
		// What took the deployed `demo` board down: the manifest named a snapshot
		// the bucket no longer had, so every request 500'd — permanently, because
		// nothing in the request path could get past `init()` to fix it. The cards
		// are gone either way; the board coming back is the point.
		// A real handshake, so the room exists on the store with a manifest.
		await post(
			"visitor",
			{ type: "hello", protocolVersion: 1, clientId: "visitor", token: "t" },
			"demo",
		);

		const driver = createKanbanDriver();

		const manifestKey = (await driver.list("rooms/demo/")).map((e) => e.key).find((k) =>
			k.endsWith("_manifest"),
		)!;
		const manifest = JSON.parse(
			new TextDecoder().decode((await driver.get(manifestKey))!.body),
		);
		// Point the manifest at a snapshot that was never written — the same shape
		// as a store that lost the object.
		manifest.snapshotKey = "rooms/demo/snap/gone-0.json";
		await driver.put(manifestKey, new TextEncoder().encode(JSON.stringify(manifest)));

		const recovered = await openBoard("demo");
		try {
			expect((await recovered.storage.getRow("cards", "nothing")).row).toBeNull();
		} finally {
			await closeBoard(recovered);
		}
	});
});

describe("board ids", () => {
	test("are restricted to a slug, so one board cannot address another's prefix", () => {
		const id = (raw: string) =>
			boardIdFrom(new URL(`https://x.invalid/?board=${encodeURIComponent(raw)}`));
		expect(id("Team-Alpha")).toBe("team-alpha");
		expect(id("../secrets")).toBe("secrets");
		expect(id("a/b")).toBe("ab");
		expect(id("")).toBe("demo");
		expect(id("!!!")).toBe("demo");
		expect(boardIdFrom(new URL("https://x.invalid/"))).toBe("demo");
	});
});

describe("card positioning", () => {
	test("a drop between two cards writes one row, not a renumbering", () => {
		expect(positionBetween(1, 2)).toBe(1.5);
		expect(positionBetween(null, 5)).toBe(4);
		expect(positionBetween(5, null)).toBe(6);
		expect(positionBetween(null, null)).toBe(0);
	});

	test("ties sort by id, so every client shows the same order", () => {
		const cards = [
			{ id: "b", title: "", column: "todo", position: 1 },
			{ id: "a", title: "", column: "todo", position: 1 },
		] as Card[];
		expect(sortCards(cards).map((c) => c.id)).toEqual(["a", "b"]);
	});
});
