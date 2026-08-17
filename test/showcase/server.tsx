import { serve } from "bun";
import { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createServer } from "../../src/server/server.ts";
import { createSqliteStorage } from "../../src/server/storage/sqlite.ts";
import type {
	AuthContext,
	ClientMessage,
	ServerMessage,
	ServerTransport,
} from "../../src/core/types.ts";
import type { SyncEvent } from "../../src/server/types.ts";
import index from "./index.html";

// ── Schema ───────────────────────────────────────────────────────────────────

const tasks = sqliteTable("tasks", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
	description: text("description"),
	status: text("status").notNull().default("todo"), // todo, in_progress, done
	priority: text("priority").notNull().default("medium"), // low, medium, high
	assignee: text("assignee"),
	projectId: text("project_id").notNull(),
	createdBy: text("created_by").notNull(),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at"),
	deletedAt: text("deleted_at"),
	position: integer("position").notNull().default(0),
});

const projects = sqliteTable("projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	color: text("color").notNull(),
	createdBy: text("created_by").notNull(),
});

const comments = sqliteTable("comments", {
	id: text("id").primaryKey(),
	taskId: text("task_id").notNull(),
	text: text("text").notNull(),
	authorId: text("author_id").notNull(),
	createdAt: text("created_at").notNull(),
});

// ── Database ─────────────────────────────────────────────────────────────────

const sqliteDb = new Database("./showcase.db");
sqliteDb.run("PRAGMA journal_mode = WAL");

sqliteDb.run(`CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'todo',
	priority TEXT NOT NULL DEFAULT 'medium',
	assignee TEXT,
	project_id TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT,
	deleted_at TEXT,
	position INTEGER NOT NULL DEFAULT 0
)`);

sqliteDb.run(`CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	color TEXT NOT NULL,
	created_by TEXT NOT NULL
)`);

sqliteDb.run(`CREATE TABLE IF NOT EXISTS comments (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	text TEXT NOT NULL,
	author_id TEXT NOT NULL,
	created_at TEXT NOT NULL
)`);

// Seed default project
sqliteDb.run(`INSERT OR IGNORE INTO projects (id, name, color, created_by) VALUES
	('proj-1', 'Launch v1.0', '#6366f1', 'system'),
	('proj-2', 'Design System', '#f59e0b', 'system')`);

const db = drizzle(sqliteDb);
const storage = createSqliteStorage({ db: sqliteDb });

// ── WS Transport ─────────────────────────────────────────────────────────────

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
			if (ws) ws.send(JSON.stringify(message));
		},

		async broadcast(roomId: string, message: ServerMessage, exclude?: string) {
			for (const [clientId, ws] of clients) {
				if (clientId !== exclude) ws.send(JSON.stringify(message));
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
			for (const ws of clients.values()) ws.close();
			clients.clear();
		},
	};
}

// ── Auth ─────────────────────────────────────────────────────────────────────

// Simulated users: token → user info
const USERS: Record<string, { userId: string; name: string; avatar: string }> = {
	"alice-token": { userId: "alice", name: "Alice", avatar: "A" },
	"bob-token": { userId: "bob", name: "Bob", avatar: "B" },
};

interface AppAuth extends AuthContext {
	name: string;
	avatar: string;
}

// ── Sync Server ──────────────────────────────────────────────────────────────

const wsTransport = createBunWsTransport();

const syncServer = createServer<BunSQLiteDatabase, AppAuth>({
	db,
	transport: wsTransport,
	serverId: "showcase-server",
	storage,
	onEvent: (event: SyncEvent) => {
		// Observability: log all sync lifecycle events
		const ts = new Date().toISOString().slice(11, 19);
		switch (event.type) {
			case "client_connected":
				console.log(`[${ts}] + Client connected: ${event.clientId}`);
				break;
			case "client_disconnected":
				console.log(`[${ts}] - Client disconnected: ${event.clientId}`);
				break;
			case "auth_failed":
				console.log(`[${ts}] ! Auth failed: ${event.clientId}`);
				break;
			case "ops_processed":
				console.log(
					`[${ts}] ops: ${event.accepted} accepted, ${event.rejected} rejected (${event.clientId})`,
				);
				break;
			case "bootstrap":
				console.log(`[${ts}] bootstrap: ${event.queries} queries (${event.clientId})`);
				break;
			case "resume":
				console.log(`[${ts}] resume: ${event.tablesChanged} tables changed (${event.clientId})`);
				break;
			case "compaction":
				console.log(`[${ts}] compaction: ${event.deletedOps} ops deleted`);
				break;
		}
	},
});

// ── Auth: extract token from header
syncServer.auth(async (req: Request) => {
	const header = req.headers.get("authorization");
	const token = header?.replace("Bearer ", "");
	const user = token ? USERS[token] : null;
	if (!user) throw new Error("Invalid token");
	return { userId: user.userId, name: user.name, avatar: user.avatar };
});

// ── Room: project-scoped subscriptions
syncServer.room("project/:projectId", async ({ params, auth }) => {
	// Any authenticated user can join any project room
	return { ok: true };
});

// ── Query: projects (read-only list, no mutations)
syncServer.query("projects", (_ctx, db) => db.select().from(projects), {
	tables: ["projects"],
	conflict: "lww",
	mutate: async (op, _ctx, db) => {
		if (op.type === "delete") {
			await db.delete(projects).where(eq(projects.id, op.rowId));
		} else {
			await db
				.insert(projects)
				.values({ id: op.rowId, ...op.payload } as typeof projects.$inferInsert)
				.onConflictDoUpdate({ target: projects.id, set: op.payload as Record<string, unknown> });
		}
	},
});

// ── Query: tasks — full CRUD with serverSet, readonly, auth-scoped, windowed
syncServer.query(
	"tasks",
	(ctx, db) => {
		// Filter tasks by project room
		const projectId = ctx.params?.projectId as string;
		if (projectId) {
			return db.select().from(tasks).where(eq(tasks.projectId, projectId));
		}
		return db.select().from(tasks);
	},
	{
		tables: ["tasks"],
		conflict: "merge", // Column-level merging: two users can edit different fields
		countHints: true, // Enable total count for windowed sync
		serverSet: {
			// Auto-injected by server — clients can't forge these
			createdBy: (ctx: { auth: AppAuth }) => ctx.auth.userId,
			updatedAt: () => new Date().toISOString(),
		},
		readonly: ["createdAt", "createdBy"], // Client can't overwrite these after creation
		mutate: async (op, ctx, db) => {
			if (op.type === "delete") {
				// Soft delete: set deletedAt instead of removing
				await db
					.update(tasks)
					.set({ deletedAt: new Date().toISOString() })
					.where(eq(tasks.id, op.rowId));
			} else {
				await db
					.insert(tasks)
					.values({ id: op.rowId, ...op.payload } as typeof tasks.$inferInsert)
					.onConflictDoUpdate({
						target: tasks.id,
						set: op.payload as Record<string, unknown>,
					});
			}
			// Tell the server that comments might be affected (cascade broadcast)
			return { affected: ["comments"] };
		},
		authorize: async (action, ctx, _db) => {
			// Only the assignee or creator can modify a task
			// (read access is open to project members)
			if (action.type === "read") return;
			// Allow all writes for demo purposes
		},
	},
);

// ── Query: comments — eager broadcast for real-time chat feel
syncServer.query(
	"comments",
	(ctx, db) => {
		const taskId = ctx.params?.taskId as string;
		if (taskId) {
			return db.select().from(comments).where(eq(comments.taskId, taskId));
		}
		return db.select().from(comments);
	},
	{
		tables: ["comments"],
		conflict: "lww",
		broadcast: "eager", // Broadcast immediately, persist in background
		mutate: async (op, ctx, db) => {
			if (op.type === "delete") {
				await db.delete(comments).where(eq(comments.id, op.rowId));
			} else {
				await db
					.insert(comments)
					.values({ id: op.rowId, ...op.payload } as typeof comments.$inferInsert)
					.onConflictDoUpdate({ target: comments.id, set: op.payload as Record<string, unknown> });
			}
		},
	},
);

// ── Rate limiting
syncServer.rateLimit({ opsPerSecond: 50, opsPerMinute: 500 });

// ── Compaction: clean up old ops after 1 hour
syncServer.compaction({ minOpAge: "1h" });

// ── Bun HTTP + WebSocket Server ──────────────────────────────────────────────

const clientIds = new Map<unknown, string>();

serve({
	port: 3002,
	routes: { "/*": index },
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

// Run compaction every 5 minutes
setInterval(() => syncServer.runCompaction(), 5 * 60 * 1000);

console.log("");
console.log("  reflectdb showcase");
console.log("  http://localhost:3002");
console.log("  ws://localhost:3002/sync");
console.log("");
console.log("  Open in multiple tabs to see real-time sync");
console.log("  Use ?user=alice or ?user=bob for different users");
console.log("");
