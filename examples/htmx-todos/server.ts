/**
 * htmx 4 + reflectdb todos.
 *
 * The server is an ordinary reflectdb sync server — it renders no HTML at all.
 * Every fragment in this demo is produced in the browser by `client.ts` from
 * the local store, which is what makes the list work offline and update the
 * moment a peer's op arrives.
 */

import { serve } from "bun";
import { createSyncServer } from "../../src/server/typed-server.ts";
import { createBunWsServerTransport } from "../../src/transport/bun-ws.ts";
import { queries } from "./schema.ts";
import type { Todo } from "./schema.ts";

/**
 * The whole database. It is passed to `createSyncServer` as `db` and handed
 * back to `query` — reflectdb only runs a query callback when it has a `db` to
 * hand it, so a server that closes over its store instead of declaring it
 * returns an empty snapshot to every client that connects.
 */
const todos = new Map<string, Todo>();

const { transport, websocket } = createBunWsServerTransport();

const server = createSyncServer<typeof queries, typeof todos>({
	queries,
	db: todos,
	transport,
	serverId: "htmx-todos",
});

server.auth(async () => ({ userId: "demo-user" }));

server.implement("todos", {
	query: (_ctx, db) => [...db.values()],
	mutate: async (op) => {
		if (op.type === "delete") {
			todos.delete(op.rowId);
			return;
		}
		const existing = todos.get(op.rowId);
		const payload = op.payload as Partial<Todo>;
		todos.set(op.rowId, {
			...(existing ?? { id: op.rowId, text: "", done: false, createdAt: Date.now() }),
			...payload,
			id: op.rowId,
			// `serverSet` stamps its columns on every op, not just the insert, so
			// `payload.createdAt` is the time of THIS write. Keeping it would make
			// createdAt a last-touched time and send every toggled row to the end
			// of the view's sort — the list visibly reshuffling as people tick
			// things. The row's birth time is whatever it already had.
			createdAt: existing?.createdAt ?? payload.createdAt ?? Date.now(),
		});
	},
	serverSet: { createdAt: () => Date.now() },
});

// ── Periodic reset ─────────────────────────────────────────────────────

const RESET_MS = 60_000;

const SEED: { id: string; text: string; done: boolean }[] = [
	{ id: "seed-1", text: "open this page in a second tab", done: false },
	{ id: "seed-2", text: "tick something and watch both lists", done: false },
	{ id: "seed-3", text: "go offline and keep typing", done: true },
];

/**
 * Put the board back to the seed rows.
 *
 * Every change goes through `applyServerOp` rather than mutating the Map alone:
 * that is what stamps an HLC, appends to the op log, updates reflectdb's mirror
 * and broadcasts the delta. A bare `todos.clear()` would leave the mirror
 * holding rows with live clocks, so the next client write could resurrect them,
 * and nobody already connected would see the reset at all.
 */
async function reset(): Promise<void> {
	// Array.from, not a live iterator: the loop body deletes from the Map it is
	// walking.
	for (const id of Array.from(todos.keys())) {
		await server.applyServerOp(
			{ type: "delete", table: "todos", rowId: id, payload: null },
			async () => {
				todos.delete(id);
			},
		);
	}

	for (const row of SEED) {
		const createdAt = Date.now();
		await server.applyServerOp(
			{
				type: "insert",
				table: "todos",
				rowId: row.id,
				payload: { text: row.text, done: row.done, createdAt },
			},
			async () => {
				todos.set(row.id, { id: row.id, text: row.text, done: row.done, createdAt });
			},
		);
	}
}

await reset();
server.interval(RESET_MS, reset);

// ── Client bundle ──────────────────────────────────────────────────────

let prebuilt: string | null = null;

async function buildClient(): Promise<string> {
	// In production the bundle is built once at image build time — see the
	// Dockerfile. In dev it is rebuilt per request so `bun --hot` picks up edits
	// to client.ts without a restart.
	if (process.env.NODE_ENV === "production") {
		prebuilt ??= await Bun.file(`${import.meta.dir}/client.js`).text();
		return prebuilt;
	}

	const result = await Bun.build({
		entrypoints: [`${import.meta.dir}/client.ts`],
		target: "browser",
		minify: false,
	});
	if (!result.success) {
		throw new AggregateError(result.logs, "client bundle failed");
	}
	return (await result.outputs[0]?.text()) ?? "";
}

// ── HTTP ───────────────────────────────────────────────────────────────

/**
 * First free port at or above the requested one. Another demo already holding
 * 3005 should move this one along, never take the port out from under it.
 */
function listen(startPort: number, options: Parameters<typeof serve>[0]) {
	for (let port = startPort; port < startPort + 20; port++) {
		try {
			return serve({ ...options, port } as Parameters<typeof serve>[0]);
		} catch (error) {
			if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
		}
	}
	throw new Error(`no free port in ${startPort}..${startPort + 19}`);
}

const app = listen(Number(process.env.PORT ?? 3005), {
	websocket,
	async fetch(request: Request, bunServer: { upgrade: (r: Request, o: unknown) => boolean }) {
		const url = new URL(request.url);

		if (url.pathname === "/sync") {
			// The key must be `id` — `createBunWsServerTransport` reads `ws.data.id`
			// to route replies, and `req` is what reaches the `auth()` callback.
			const data = { id: `ws-${crypto.randomUUID().slice(0, 8)}`, req: request };
			if (bunServer.upgrade(request, { data })) return;
			return new Response("expected a websocket upgrade", { status: 426 });
		}

		if (url.pathname === "/client.js") {
			return new Response(await buildClient(), {
				headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
			});
		}

		return new Response(Bun.file(`${import.meta.dir}/index.html`), {
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
		});
	},
} as Parameters<typeof serve>[0]);

console.log(`htmx todos on http://localhost:${app.port} — open it in two tabs`);
