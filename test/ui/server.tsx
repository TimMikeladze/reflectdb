import { serve } from "bun";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createServer } from "../../src/server/server.ts";
import { createSqliteStorage } from "../../src/server/storage/sqlite.ts";
import type { ClientMessage, ServerMessage, ServerTransport } from "../../src/core/types.ts";
import index from "./index.html";

// ── Schema ──────────────────────────────────────────────────────────────────

const cells = sqliteTable("cells", {
	id: text("id").primaryKey(), // "row,col" e.g. "3,7"
	color: text("color").notNull(),
	playerId: text("player_id").notNull(),
});

// ── Database ────────────────────────────────────────────────────────────────

const sqliteDb = new Database("./tictactoe.db");
sqliteDb.run("PRAGMA journal_mode = WAL");

sqliteDb.run(`CREATE TABLE IF NOT EXISTS cells (
	id TEXT PRIMARY KEY,
	color TEXT NOT NULL,
	player_id TEXT NOT NULL
)`);

const db = drizzle(sqliteDb);
const storage = createSqliteStorage({ db: sqliteDb });

// ── In-process WS Server Transport ──────────────────────────────────────────

interface BunWs {
	send(data: string): void;
	close(): void;
}

function createBunWsTransport(): ServerTransport & {
	handleUpgrade(ws: BunWs, clientId: string): void;
	_messageHandler: ((clientId: string, message: ClientMessage) => void) | null;
	_disconnectHandler: ((clientId: string) => void) | null;
} {
	const clients = new Map<string, BunWs>();
	let messageHandler: ((clientId: string, message: ClientMessage) => void) | null = null;
	let connectHandler: ((clientId: string, req: Request) => void) | null = null;
	let disconnectHandler: ((clientId: string) => void) | null = null;

	return {
		_messageHandler: null,
		_disconnectHandler: null,

		handleUpgrade(ws: BunWs, clientId: string) {
			clients.set(clientId, ws);
			connectHandler?.(clientId, new Request("https://sync"));
		},

		async send(clientId: string, message: ServerMessage) {
			const ws = clients.get(clientId);
			if (ws) {
				ws.send(JSON.stringify(message));
			}
		},

		async broadcast(roomId: string, message: ServerMessage, exclude?: string) {
			for (const [clientId, ws] of clients) {
				if (clientId !== exclude) {
					ws.send(JSON.stringify(message));
				}
			}
		},

		onMessage(handler) {
			messageHandler = handler;
			this._messageHandler = handler;
		},

		onConnect(handler) {
			connectHandler = handler;
		},

		onDisconnect(handler) {
			disconnectHandler = handler;
			this._disconnectHandler = handler;
		},

		async close() {
			for (const ws of clients.values()) {
				ws.close();
			}
			clients.clear();
		},
	};
}

// ── Setup ───────────────────────────────────────────────────────────────────

const wsTransport = createBunWsTransport();

const syncServer = createServer<BunSQLiteDatabase>({
	db,
	transport: wsTransport,
	serverId: "ttt-server",
	storage,
});

syncServer.auth(async () => ({ userId: "player" }));

syncServer.query("cells", (_ctx, db) => db.select().from(cells), {
	tables: ["cells"],
	conflict: "lww",
	mutate: async (op, _ctx, db) => {
		if (op.type === "delete") {
			await db.delete(cells).where(eq(cells.id, op.rowId));
		} else {
			await db
				.insert(cells)
				.values({ id: op.rowId, ...op.payload } as typeof cells.$inferInsert)
				.onConflictDoUpdate({ target: cells.id, set: op.payload as Record<string, unknown> });
		}
	},
});

syncServer.rateLimit({ opsPerSecond: 200 });

// ── Bun Server ──────────────────────────────────────────────────────────────

const clientIds = new Map<unknown, string>();

serve({
	port: 3001,
	routes: {
		"/*": index,
	},
	websocket: {
		open(ws) {
			const clientId = `ws-${Math.random().toString(36).slice(2, 8)}`;
			clientIds.set(ws, clientId);
			wsTransport.handleUpgrade(ws as unknown as BunWs, clientId);
		},
		message(ws, data) {
			const clientId = clientIds.get(ws);
			if (clientId && wsTransport._messageHandler) {
				const message = JSON.parse(data as string) as ClientMessage;
				wsTransport._messageHandler(clientId, message);
			}
		},
		close(ws) {
			const clientId = clientIds.get(ws);
			if (clientId) {
				wsTransport._disconnectHandler?.(clientId);
				clientIds.delete(ws);
			}
		},
	},
	fetch(req, server) {
		const url = new URL(req.url);
		if (url.pathname === "/sync") {
			if (server.upgrade(req)) return;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}
		return new Response("Not found", { status: 404 });
	},
});

console.log("reflectdb tic-tac-toe running at http://localhost:3001");
console.log("WebSocket endpoint: ws://localhost:3001/sync");
