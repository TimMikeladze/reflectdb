/**
 * Headless sync test — two clients playing tic-tac-toe on a shared grid.
 *
 * Usage:
 *   1. Start the server:  bun test/ui/server.tsx
 *   2. Run this script:   bun test/ui/test-sync.ts
 */

import { SyncClient } from "../../src/client/sync-client.ts";
import type {
	ClientTransport,
	ClientMessage,
	ServerMessage,
	EphemeralEvent,
} from "../../src/core/types.ts";

const WS_URL = "ws://localhost:3001/sync";

function createWsTransport(url: string): ClientTransport {
	const ws = new WebSocket(url);
	let handler: ((msg: ServerMessage) => void) | null = null;
	const queue: ClientMessage[] = [];

	ws.addEventListener("open", () => {
		for (const msg of queue) ws.send(JSON.stringify(msg));
		queue.length = 0;
	});
	ws.addEventListener("message", (e) => {
		handler?.(JSON.parse(e.data as string));
	});

	return {
		async send(msg) {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
			else queue.push(msg);
		},
		subscribe(h) {
			handler = h;
		},
		async close() {
			ws.close();
		},
	};
}

function log(label: string, ...args: unknown[]) {
	console.log(`[${label}]`, ...args);
}

async function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean) {
	if (condition) {
		console.log(`  ✅ ${name}`);
		passed++;
	} else {
		console.log(`  ❌ ${name}`);
		failed++;
	}
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
	console.log("\n=== reflectdb tic-tac-toe headless test ===\n");

	const alice = new SyncClient({
		clientId: "alice",
		transport: createWsTransport(WS_URL),
		token: "test",
		onSync: (t) => log("Alice", `sync: ${t}`),
		onError: (e) => log("Alice", "ERROR:", e),
	});

	const bob = new SyncClient({
		clientId: "bob",
		transport: createWsTransport(WS_URL),
		token: "test",
		onSync: (t) => log("Bob", `sync: ${t}`),
		onError: (e) => log("Bob", "ERROR:", e),
	});

	// ── 1. Connect ──────────────────────────────────────────────────────

	console.log("--- Connect ---");

	await alice.connect();
	await bob.connect();

	check("Alice connected", alice.getState() === "connected");
	check("Bob connected", bob.getState() === "connected");

	// ── 2. Sync cells ───────────────────────────────────────────────────

	console.log("\n--- Sync cells ---");

	await alice.sync("cells");
	await bob.sync("cells");
	await alice.bootstrap();
	await bob.bootstrap();
	await sleep(200);

	check("Alice is synced", alice.getState() === "synced");
	check("Bob is synced", bob.getState() === "synced");

	const initialCount = alice.getRows("cells").length;
	log("Info", `Starting with ${initialCount} existing cells on the board`);

	// ── 3. Alice places a cell ──────────────────────────────────────────

	console.log("\n--- Alice places a cell ---");

	const cellA = "0,0";
	alice.insert("cells", cellA, { id: cellA, color: "hsl(200, 70%, 60%)", player_id: "alice" });
	await alice.push();
	await sleep(300);

	check("Alice sees her cell", alice.getRow("cells", cellA) !== null);
	check("Bob receives Alice's cell", bob.getRow("cells", cellA) !== null);

	const bobSeesAlice = bob.getRow("cells", cellA);
	check("Bob sees correct color", bobSeesAlice?.color === "hsl(200, 70%, 60%)");

	// ── 4. Bob places a different cell ──────────────────────────────────

	console.log("\n--- Bob places a different cell ---");

	const cellB = "0,1";
	bob.insert("cells", cellB, { id: cellB, color: "hsl(30, 70%, 60%)", player_id: "bob" });
	await bob.push();
	await sleep(300);

	check("Bob sees his cell", bob.getRow("cells", cellB) !== null);
	check("Alice receives Bob's cell", alice.getRow("cells", cellB) !== null);

	const aliceSeesBob = alice.getRow("cells", cellB);
	check("Alice sees correct color", aliceSeesBob?.color === "hsl(30, 70%, 60%)");

	// ── 5. Both see full board state ────────────────────────────────────

	console.log("\n--- Board state ---");

	const aliceCells = alice.getRows("cells").length;
	const bobCells = bob.getRows("cells").length;
	check("Alice and Bob have same cell count", aliceCells === bobCells);
	check("Board has at least 2 new cells", aliceCells >= initialCount + 2);

	log("Info", `Board now has ${aliceCells} cells`);

	// ── 6. Batch placement ──────────────────────────────────────────────

	console.log("\n--- Batch placement ---");

	const batchCells = [
		{
			table: "cells",
			op: "insert" as const,
			rowId: "1,0",
			payload: { id: "1,0", color: "hsl(200, 70%, 60%)", player_id: "alice" },
		},
		{
			table: "cells",
			op: "insert" as const,
			rowId: "1,1",
			payload: { id: "1,1", color: "hsl(200, 70%, 60%)", player_id: "alice" },
		},
		{
			table: "cells",
			op: "insert" as const,
			rowId: "1,2",
			payload: { id: "1,2", color: "hsl(200, 70%, 60%)", player_id: "alice" },
		},
	];

	alice.batch(batchCells);
	await alice.push();
	await sleep(300);

	check(
		"Alice placed 3 batch cells",
		alice.getRow("cells", "1,0") !== null &&
			alice.getRow("cells", "1,1") !== null &&
			alice.getRow("cells", "1,2") !== null,
	);
	check(
		"Bob received all batch cells",
		bob.getRow("cells", "1,0") !== null &&
			bob.getRow("cells", "1,1") !== null &&
			bob.getRow("cells", "1,2") !== null,
	);

	// ── 7. Ephemeral hover ──────────────────────────────────────────────

	console.log("\n--- Ephemeral hover ---");

	const hoverEvents: EphemeralEvent[] = [];
	const unsub = bob.subscribeEphemeral("hover", (event) => {
		hoverEvents.push(event);
	});

	await alice.sendEphemeral({
		key: "hover",
		userId: "alice",
		data: { cell: "5,5", color: "hsl(200, 70%, 60%)" },
		ttlMs: 3000,
	});
	await sleep(200);

	check("Bob received Alice's hover event", hoverEvents.length >= 1);
	if (hoverEvents.length > 0) {
		check(
			"Hover event has correct cell",
			(hoverEvents[0]!.data as { cell: string }).cell === "5,5",
		);
	}

	unsub();

	// ── 8. Hard delete a cell ───────────────────────────────────────────

	console.log("\n--- Hard delete ---");

	const countBefore = alice.getRows("cells").length;
	alice.delete("cells", "1,2");
	await alice.push();
	await sleep(300);

	check("Alice: cell removed", alice.getRow("cells", "1,2") === null);
	check("Bob: cell also removed", bob.getRow("cells", "1,2") === null);
	check("Count decreased by 1", alice.getRows("cells").length === countBefore - 1);

	// ── 9. Unsync + resync ──────────────────────────────────────────────

	console.log("\n--- Unsync + resync ---");

	const cellsBefore = alice.getRows("cells").length;
	await alice.unsync("cells");
	check("After unsync, cells cleared locally", alice.getRows("cells").length === 0);

	await alice.sync("cells");
	await alice.bootstrap();
	await sleep(300);

	check("After resync, cells restored", alice.getRows("cells").length === cellsBefore);

	// ── Results ─────────────────────────────────────────────────────────

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

	if (failed > 0) {
		console.log("\n❌ SOME TESTS FAILED\n");
	} else {
		console.log("\n✅ ALL TESTS PASSED\n");
	}

	await alice.close();
	await bob.close();
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
