/**
 * Every snippet on the page, as plain source. Highlighting happens at render
 * time, so these stay copy-pasteable and diffable against the real API.
 *
 * Line-length budget: snippets rendered full width may run long; anything
 * placed in a two-column grid or a feature card is kept under ~72 columns so
 * it never needs a horizontal scrollbar.
 */

// ── Quickstart ──────────────────────────────────────────────────────────

export const SCHEMA = `// schema.ts — one definition, both sides import it
import { defineSyncQueries, t } from "reflectdb/core";

export type Todo = { id: string; title: string; done: boolean; createdAt: Date };

export const queries = defineSyncQueries({
  todos: {
    row: t<Todo>(),
    conflict: "lww",
    serverSet: ["createdAt"], // server owns it; clients cannot write it
  },
});`;

export const SERVER = `// server.ts
import { createSyncServer } from "reflectdb/server";
import { createWsServerTransport } from "reflectdb/transport/ws";
import { queries, type Todo } from "./schema";

const todos = new Map<string, Todo>();
const transport = createWsServerTransport();

const server = createSyncServer({
  queries, transport, serverId: "s1",
});

server.auth(async (req) => ({ userId: await verify(req) }));

server.implement("todos", {
  query: () => [...todos.values()],
  mutate: async (op) => {
    if (op.type === "delete") return void todos.delete(op.rowId);
    todos.set(op.rowId, { id: op.rowId, ...op.payload } as Todo);
  },
  serverSet: { createdAt: () => new Date() },
});`;

export const CLIENT = `// app.tsx
import { SyncProvider, useSync } from "reflectdb/react";

export const App = () => (
  <SyncProvider url={URL} token={token} tables={["todos"]}>
    <Todos />
  </SyncProvider>
);

function Todos() {
  const { rows, insert, update, remove } = useSync("todos");
  //      ^? Todo[]   ^? typed mutators

  return rows.map((todo) => (
    <label key={todo.id}>
      <input
        type="checkbox"
        checked={todo.done}
        onChange={() => update(todo.id, { done: !todo.done })}
      />
      {todo.title}
    </label>
  ));
}`;

export const WIRE = `// the transport hands you functions; you own the routes
serve({
  port: 3001,
  fetch(req, srv) {
    const clientId = crypto.randomUUID();
    if (new URL(req.url).pathname === "/sync"
        && srv.upgrade(req, { data: { clientId } })) return;
    return new Response("ok");
  },
  websocket: {
    open(ws) { transport.handleOpen(ws.data.clientId, ws); },
    message(ws, d) { transport.handleMessage(ws.data.clientId, String(d)); },
    close(ws) { transport.handleClose(ws.data.clientId); },
    pong(ws) { transport.handlePong(ws.data.clientId); },
  },
});`;

// ── Concepts ────────────────────────────────────────────────────────────

export const OPTIMISTIC = `update("todos", id, { done: true });
// 1. op stamped with an HLC, queued in memory + IndexedDB
// 2. row patched locally — the UI has already repainted
// 3. push() ships it; offline, it simply waits

usePendingCount();  // 2 → 0 as acks land
useSyncStatus();    // "synced" | "connecting" | "disconnected"

// a reject reverts the row to the state captured before the
// op was applied — not to empty, and not to a later delta`;

export const HLC = `import { packHlc, compareHlc, sendHlc } from "reflectdb/core";

packHlc({ ms: 1711234567890, counter: 3, nodeId: "abc" });
// "0000001711234567890.0003.abc"
//  └ zero-padded ms ──┘ └ctr┘ └origin┘

compareHlc(a, b) > 0;  // plain string compare, causal order
sendHlc(local);        // max(wall, last); counter++ on a tie

// receiveHlc clamps a remote clock to wall + 5 min, so one
// broken client cannot drag the deployment into the future`;

export const CONFLICT = `defineSyncQueries({
  posts:  { row: t<Post>(),   conflict: "lww" },     // row-level, newest wins
  docs:   { row: t<Doc>(),    conflict: "merge" },   // per-column clocks
  config: { row: t<Config>(), conflict: "server" },  // first write wins
  bids:   {
    row: t<Bid>(),
    conflict: {
      policy: "custom",
      resolve: (incoming, existing) => {
        const bid = Number(incoming.payload?.amount ?? 0);
        if (bid <= Number(existing.row?.amount ?? 0)) {
          throw new MutationError("custom_conflict", "bid too low");
        }
        return { row: { ...existing.row, ...incoming.payload } };
      },
    },
  },
});`;

export const GROUP_BY = `server.implement("posts", {
  query: ({ auth }, db) =>
    db.select().from(posts).where(eq(posts.orgId, auth.orgId)),

  // The result depends on orgId alone, so every member of an org can share
  // one execution and one diff instead of one per connected client.
  groupBy: ({ auth }) => String(auth.orgId),
});`;

export const EAGER = `server.implement("strokes", {
  query: ({ params }, db) =>
    db.select().from(strokes).where(eq(strokes.gameId, params.gameId)),
  mutate: async (op, _ctx, db) =>
    void db.insert(strokes).values({ id: op.rowId, ...op.payload }),

  broadcast: "eager-durable",  // persist, then send the delta as-is
  flushInterval: 50,
});`;

export const SERVER_ORIGIN = `// writes that skip the client protocol still have to reach the mirror

await server.emit("todos", { title: "filed by a cron", done: false });

await server.tx(async (tx) => {           // one transaction, one notify per table
  await tx.update(games).set({ state: "scoring" }).where(eq(games.id, id));
  await tx.insert(scores).values(rows);
});

await server.notifyChange("games");       // wrote with raw SQL? say so`;

export const COMPACTION = `server.compaction({
  interval: "1h",                 // how often a pass runs
  minOpAge: "5m",                 // leave younger ops alone
  clientInactivityTimeout: "24h", // ignore idle clients
});

// A watermark older than the cutoff gets resume_rejected
// and falls back to a bootstrap: more bytes, no lost rows.`;

// ── Features ────────────────────────────────────────────────────────────

export const F_TYPES = `const { rows, insert } = useSync("todos");

rows[0].title;                  // string
insert(id, { title: "x", done: false });
insert(id, { createdAt: new Date() });
//           ~~~~~~~~~ serverSet — not a writable field`;

export const F_OFFLINE = `<SyncProvider
  storage={createIndexedDBStorage({ dbName: "app" })}
  url={url} token={token} tables={["todos"]}
/>

const pending = usePendingCount();
// close the laptop, keep typing, reopen — the queue replays`;

export const F_MERGE = `{ docs: { row: t<Doc>(), conflict: "merge" } }

// A writes { title }, B writes { body }, clocks disagree:
// merge keeps both, lww keeps one and drops the other.`;

export const F_BYODB = `createSyncServer({ queries, db, transport, serverId: "s1" });

server.implement("todos", {
  query: (ctx, db) => db.select().from(todos),     // drizzle
  // (ctx, db) => db.selectFrom("todos")…          // kysely
  // (ctx, db) => db.todo.findMany()               // prisma
  // (ctx, db) => db.query("select …")             // raw sql
});`;

export const F_PARAMS = `const queries = defineSyncQueries({
  posts: {
    row: t<Post>(),
    params: t<{ orgId: string }>(),  // required on sync()
    readonly: ["orgId"],             // and never writable
  },
});

server.implement("posts", {
  query: (ctx, db) =>
    db.select().from(posts)
      .where(eq(posts.orgId, ctx.params.orgId)),
});

useSync("posts", { params: { orgId: "org-42" } });`;

export const F_AUTH = `server.auth(async (req) => {
  const session = await validate(bearer(req));
  if (!session) throw new Error("unauthorized");
  return { userId: session.userId, orgId: session.orgId };
});

// ctx.auth reaches every query, mutate and authorize call
server.implement("todos", {
  authorize: async (action, ctx) => {
    if (action.type === "write" && ctx.auth.readOnly) {
      throw new MutationError("mutation_rejected");
    }
  },
  query: (ctx, db) =>
    db.select().from(todos)
      .where(eq(todos.userId, ctx.auth.userId)),
});`;

export const F_ROOMS = `server.room("org/:orgId", ({ params, auth }) => {
  if (!auth.orgs.includes(params.orgId)) {
    return { ok: false, reason: "not a member" };
  }
  // return nothing to allow
});

server.implement("posts", { room: "org/:orgId", query });

// params that half-address a pattern are rejected outright,
// never widened into a cross-room subscription`;

export const F_VALIDATE = `import { MutationError } from "reflectdb/core";
import { z } from "zod";

const Todo = z.object({
  title: z.string().min(1).max(200),
  done: z.boolean(),
}).strict();

server.implement("todos", {
  mutate: async (op, ctx, db) => {
    // an update carries a partial delta, not a whole row
    const shape = op.type === "insert" ? Todo : Todo.partial();
    const parsed = shape.safeParse(op.payload);
    if (!parsed.success) {
      throw new MutationError("outside_shape");
    }
    await write(op.rowId, parsed.data);  // not op.payload
  },
});`;

export const F_REST = `const rest = server.rest({ prefix: "/api" });

// GET    /api/todos      ?where=&limit=&offset=
// GET    /api/todos/:id
// POST   /api/todos      body = row, or an array to batch
// PATCH  /api/todos/:id
// DELETE /api/todos/:id

// same pipeline as sync — REST writes broadcast deltas too`;

export const F_EPHEMERAL = `const { events, broadcast } = useEphemeral<Cursor>({
  key: \`cursor:\${gameId}\`,
  userId,
  ttlMs: 10_000,
});

onMouseMove={(e) => broadcast({ x: e.clientX, y: e.clientY })}

Object.values(events).map((c) => <Peer x={c.x} y={c.y} />)
// room-scoped, never persisted, metered on its own bucket`;

export const F_PRESENCE = `const queries = defineSyncQueries({
  cursors: presence({
    state: t<{ x: number; y: number }>(),
    ttlMs: 10_000,
  }),
});

const { peers, set } = usePresence("cursors");
//      ^? { userId: string; state: { x, y } }[]`;

export const F_VIEW = `const queries = defineSyncQueries({
  leaderboard: view({
    row: t<Score>(),
    deps: ["games", "scores"],
  }),
});

server.view("leaderboard", (ctx, db) =>
  db.select().from(scores).orderBy(desc(scores.points)));

const { rows } = useSync("leaderboard");
// no .insert / .update / .remove — types and runtime agree`;

export const F_WINDOW = `const { rows } = useSync("messages", { window: 50 });
const total = useTotalCount("messages");
const loadMore = useLoadMore("messages");  // loadMore(50)

server.implement("messages", {
  query: ({ params, limit }, db) =>
    db.select().from(messages)
      .where(eq(messages.roomId, params.roomId))
      .limit(limit ?? 1000),
  count: ({ params }, db) => countRows(db, params.roomId),
});
// with count(), the window becomes a real SQL LIMIT`;

export const F_RATE = `server.rateLimit({
  opsPerSecond: 20,
  opsPerMinute: 600,
  perTable: {
    strokes:  { opsPerSecond: 120 },  // drawing is chatty
    messages: { opsPerSecond: 2 },    // chat is not
  },
  ephemeralPerSecond: 60,
});
// fail-open: if the limiter itself throws, ops still flow`;

export const F_HA = `import { createPostgresStorage } from "reflectdb/server";

createSyncServer({
  queries, db, transport,
  storage: createPostgresStorage(pool),
  serverId: process.env.FLY_ALLOC_ID,
  poll: 500,   // active-active; omit it for failover-only
});
// an idle tick is one MAX(hlc) query and no broadcast`;

export const F_LOOP = `server.interval(500, () =>
  server.lock("tick", async () => {  // never outruns itself
    const ended = await expireRounds();
    if (ended) await server.notifyChange("games");
  }),
);`;

export const F_PERUSER = `server.implement("roundWord", {
  query: async (ctx, db) => {
    const game = await loadGame(db, ctx.params.gameId);
    // guessers get [] — the word never reaches their socket
    if (game.drawerId !== ctx.auth.userId) return [];
    return [{ id: game.id, word: await secret(db, game.id) }];
  },
  tables: ["games", "game_secrets"],  // re-run on either
});`;

export const F_SOFTDELETE = `// rows with deletedAt / deleted_at drop out of reads
const { rows } = useSync("todos");
const all = useSync("todos", { includeDeleted: true });`;

export const F_EVENTS = `createSyncServer({
  queries, transport, serverId: "s1",
  onEvent: (e) => metrics.increment(e.type),
});
// client_connected · ops_processed · bootstrap · resume
// query_error · auth_failed · queue_overflow · compaction`;

// ── Transports ──────────────────────────────────────────────────────────

export const T_WS = `import { createWsServerTransport } from "reflectdb/transport/ws";

const transport = createWsServerTransport({
  maxMessageBytes: 1_000_000,
  pingIntervalMs: 30_000,
  maxBufferedBytes: 8_000_000,  // outbound backpressure
});

// handleOpen · handleMessage · handleClose · handlePong
// isOriginAllowed(req, origins) guards the upgrade`;

export const T_BUNWS = `import { createBunWsServerTransport } from "reflectdb/transport/bun-ws";

const { transport, websocket } = createBunWsServerTransport();

serve({
  port: 3001,
  fetch: (req, srv) =>
    srv.upgrade(req, { data: { id: crypto.randomUUID(), req } })
      ? undefined
      : new Response("ok"),
  websocket,   // hand Bun the handlers verbatim
});`;

export const T_SSE = `import { createSseServerTransport } from "reflectdb/transport/sse";

const sse = createSseServerTransport({ replayBufferSize: 256 });

// GET  /sync/events/:id
//   → new Response(sse.createEventStream(id, lastEventId))
// POST /sync/messages/:id
//   → sse.handleMessage(id, await req.json())`;

export const T_POLL = `import { createPollingServerTransport } from "reflectdb/transport/polling";

const poll = createPollingServerTransport({ maxQueueLen: 1000 });

// POST /sync/connect/:id → poll.handleConnect(id)
// GET  /sync/poll/:id    → { messages: poll.handlePoll(id) }
// POST /sync/send/:id    → poll.handleMessage(id, body)`;

// ── Bindings ────────────────────────────────────────────────────────────

export const B_REACT = `import { createSyncReact } from "reflectdb/react";

export const {
  SyncProvider, useSync, useRow, useSyncStatus,
  usePendingCount, useEphemeral, usePresence,
  useTotalCount, useLoadMore,
} = createSyncReact(queries);

const { rows, insert, update, remove } = useSync("todos");
const one = useRow("todos", id);`;

export const B_SVELTE = `import { createSyncStore } from "reflectdb/svelte";

const store = createSyncStore({ url, token, tables: ["notes"] });
const { rows, insert } = store.sync<Note>("notes");

store.connect();

// {#each $rows as note}…{/each}
// $store.status · $store.pendingCount`;

export const B_VANILLA = `import { createSync } from "reflectdb/vanilla";

const sync = createSync({ url, token, tables: ["notes"] });
const notes = sync.sync<Note>("notes");

notes.onChange(render);
notes.insert(crypto.randomUUID(), { title: "hello" });
sync.connect();`;

export const B_CORE = `import { createSyncClient } from "reflectdb/client";
import { createBrowserWsTransport } from "reflectdb/vanilla";

const client = createSyncClient({
  queries,
  clientId: "worker-1",
  token,
  transport: createBrowserWsTransport(URL),
});

await client.connect();
await client.sync("todos");
client.subscribeTable("todos", () => {
  render(client.getRows("todos"));
});`;

export const STORAGE = `// server op log
createSyncServer({ /* no storage */ });    // in-memory
createSqliteStorage({ path: "sync.db" });  // bun:sqlite
createPostgresStorage(pool);               // multi-node HA

// browser
createMemoryStorage();                     // tests, SSR
createIndexedDBStorage({ dbName: "app" }); // production`;

export const DIFF_EXAMPLE = `cached result set      fresh query result     delta sent
──────────────────────────────────────────────────────────
{ id: a, n: 1 }        { id: a, n: 1 }        — (unchanged)
{ id: b, n: 2 }        { id: b, n: 9 }        update b { n: 9 }
{ id: c, n: 3 }        —                      delete c
—                      { id: d, n: 4 }        insert d { … }`;
