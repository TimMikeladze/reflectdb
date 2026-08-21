# reflectdb

[![npm version](https://img.shields.io/npm/v/reflectdb.svg)](https://www.npmjs.com/package/reflectdb)
[![npm downloads](https://img.shields.io/npm/dm/reflectdb.svg)](https://www.npmjs.com/package/reflectdb)
[![CI](https://github.com/TimMikeladze/reflectdb/actions/workflows/ci.yml/badge.svg)](https://github.com/TimMikeladze/reflectdb/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/reflectdb.svg)](https://www.typescriptlang.org)
[![license](https://img.shields.io/npm/l/reflectdb.svg)](./LICENSE)

A real-time sync engine for TypeScript. Keeps a server-side database in sync with any number of browser clients — offline-first, with optimistic local writes, automatic conflict resolution, and end-to-end type inference.

You bring your own types and your own database. reflectdb handles the protocol, the op log, conflicts, reconnection, and subscriptions.

```
┌──────────────┐   writes    ┌──────────────┐   writes    ┌──────────────┐
│  Browser A   │ ──────────▶ │    Server    │ ◀────────── │  Browser B   │
│ (optimistic) │   deltas    │ (authoritive)│   deltas    │ (optimistic) │
│              │ ◀────────── │              │ ──────────▶ │              │
└──────────────┘             └──────────────┘             └──────────────┘
       ▲                            │
       │      offline               ▼
       └────── IndexedDB ───── op log (in-memory / SQLite / Postgres)
```

## Table of Contents

- [Demos](#demos)
- [Why reflectdb](#why-reflectdb)
- [Features](#features)
- [Use Cases](#use-cases)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Recipes](#recipes)
  - [WebSocket sync with SQLite + Drizzle](#websocket-sync-with-sqlite--drizzle)
  - [Typed params for multi-tenant queries](#typed-params-for-multi-tenant-queries)
  - [Authentication and room-based access control](#authentication-and-room-based-access-control)
  - [Per-column merge for collaborative editing](#per-column-merge-for-collaborative-editing)
  - [Custom conflict resolvers](#custom-conflict-resolvers)
  - [Validating client payloads](#validating-client-payloads)
  - [Ephemeral messages (cursors, presence, typing)](#ephemeral-messages-cursors-presence-typing)
  - [Typed presence](#typed-presence)
  - [Per-user query results](#per-user-query-results)
  - [Read-only views](#read-only-views)
  - [Server-driven game loops](#server-driven-game-loops)
  - [Transactional writes with `server.tx`](#transactional-writes-with-servertx)
  - [Windowed sync and pagination](#windowed-sync-and-pagination)
  - [Auto-generated REST API](#auto-generated-rest-api)
  - [High availability with Postgres](#high-availability-with-postgres)
- [Whiteboard + Pictionary example](#whiteboard--pictionary-example)
- [Infinite Tetris example](#infinite-tetris-example)
- [Architecture](#architecture)
- [Core Concepts](#core-concepts)
  - [Hybrid Logical Clocks](#hybrid-logical-clocks)
  - [Conflict Resolution](#conflict-resolution)
  - [The Sync Protocol](#the-sync-protocol)
  - [Two stores, one sync](#two-stores-one-sync)
  - [The Op Log and Resume](#the-op-log-and-resume)
- [API Reference](#api-reference)
  - [`reflectdb/core`](#reflectdbcore)
  - [`reflectdb/server`](#reflectdbserver)
  - [`reflectdb/client`](#reflectdbclient)
  - [`reflectdb/react`](#reflectdbreact)
  - [`reflectdb/svelte`](#reflectdbsvelte)
  - [`reflectdb/vanilla`](#reflectdbvanilla)
  - [`reflectdb/transport/*`](#reflectdbtransport)
- [Configuration Reference](#configuration-reference)
  - [Query definition](#query-definition)
  - [View definition](#view-definition)
  - [Presence definition](#presence-definition)
  - [Server configuration](#server-configuration)
  - [`implement()` options](#implement-options)
  - [Rate limiting](#rate-limiting)
  - [Compaction](#compaction)
  - [Client configuration](#client-configuration)
  - [Storage adapters](#storage-adapters)
  - [Transport configuration](#transport-configuration)
- [Development](#development)
- [License](#license)

## Demos

| Demo | Try it | What it demonstrates |
|------|--------|----------------------|
| **Infinite multiplayer Tetris** | [Play live](https://reflectdb-tetris.fly.dev/) · [source](./examples/tetris/) | Optimistic input prediction, server reconciliation and gravity, a live leaderboard, per-player progression, and Bun SQLite persistence in one perpetual game. Open two tabs to add another player. |
| **Collaborative whiteboard** | [Draw live](https://reflectdb-whiteboard.fly.dev/) · [source](./examples/whiteboard/) | Freeform drawing by default, optional Pictionary rounds, guest-authenticated rooms, ephemeral cursors, chat, presence, and per-user query results. Rooms and everything in them are deleted 30 minutes after they are created. Open two tabs to draw with yourself. |

Both demos run on one auto-stopping Fly Machine with no volume, so the first load
after an idle period may take a moment. Their data is intentionally ephemeral
across deployments and Machine replacement.

## Why reflectdb

Most real-time sync libraries force you to choose: CRDTs (powerful but opaque), or simple pub/sub (fast but brittle). reflectdb sits in the middle — **per-row operations** with **hybrid logical clocks** for causal ordering, validated through a server-side pipeline so your database stays authoritative.

You define your schema once, and the same types flow to both sides:

```ts
const { rows, insert } = useSync("todos");
//      ^? Todo[]   ^? (id, { title, done, createdAt? }) => void
```

No code generation. No glue layer. No second source of truth.

**Bring your own stack.** reflectdb is agnostic about:

- **Your database** — any TypeScript ORM, raw SQL driver, Map, or REST API works. The `query`/`mutate` callbacks hand you `db` untouched.
- **Your row types** — plain TypeScript types, Drizzle `$inferSelect`, Kysely, Prisma, anything. Declare them with `t<MyRow>()`.
- **Your HTTP server** — Bun, Node, Deno, Cloudflare Workers, anything fetch-compatible. Transports expose handler functions you wire to routes.

Optional bits (use what you want):

- **Drizzle ORM** — if you point `table` at a Drizzle table, row types are auto-inferred.
- **Server op log storage** — SQLite (for single-node) or Postgres (for HA). Omit it and the op log is in-memory.
- **React / Svelte bindings** — use the core client directly if you prefer.

## Features

- **Real-time sync** over WebSocket, Server-Sent Events, or HTTP long-polling
- **Offline-first** — optimistic local writes, queued and replayed on reconnect
- **End-to-end type safety** — schema defines row types, query params, writable fields, and which columns the server owns
- **Per-row and per-column conflict resolution** — `lww`, `merge`, `server`, or a custom resolver
- **Causal ordering** via hybrid logical clocks (HLC) — no dependence on synchronized wall clocks
- **Pluggable storage** — in-memory, SQLite, or Postgres for the server op log; memory or IndexedDB for the browser
- **Auto-generated REST** — `server.rest()` turns your schema into CRUD endpoints that broadcast deltas
- **Room-based access control** — scope clients to `org/:orgId` or arbitrary patterns
- **Rate limiting** — global and per-table, fail-open
- **Op log compaction** — configurable retention for old accepted ops
- **High availability** — shared Postgres + optional cross-instance polling
- **Framework bindings** — React hooks, Svelte stores, and a vanilla-JS helper; the core client works anywhere
- **Ephemeral channels** — presence, cursors, typing indicators that never touch the op log, with a room snapshot on join and a pluggable adapter (Redis included) so presence spans a fleet
- **Typed presence** — `presence()` in the schema, `usePresence()` in the component, key derived for you
- **Read-only views** — `view()` entries that recompute on their dependencies and reject writes at both levels
- **Windowed sync** — paginate large tables with `loadMore` + `useTotalCount`
- **Server-side toolkit** — `tx` (transaction + auto-notify), `lock` / `tryLock`, and self-disposing `interval` / `timeout`

## Use Cases

- Collaborative editing (docs, whiteboards, spreadsheets)
- Multi-device note apps, todo apps, inbox-like UIs
- Live dashboards where multiple clients view and edit the same state
- Local-first apps that need to work offline and merge on reconnect
- Admin tools that should "just update" when someone else changes a row
- Field-service or retail apps on spotty networks
- Games or canvases with presence indicators and live cursors

## Installation

```bash
bun add reflectdb
# or
npm install reflectdb
```

Ships both ESM and CommonJS, so `import` and `require` both work:

```ts
import { defineSyncQueries, t } from "reflectdb";        // or "reflectdb/core"
```
```js
const { defineSyncQueries, t } = require("reflectdb");
```

Everything else is a subpath — `reflectdb/server`, `reflectdb/client`, `reflectdb/react`, and so on. The bare `reflectdb` specifier is an alias for `reflectdb/core`, the surface both sides share.

Peer dependencies are all optional:

```bash
bun add react         # for reflectdb/react
bun add drizzle-orm   # if you want auto-inferred row types from Drizzle tables
# Svelte + vanilla have no peer deps
```

## Quick Start

A complete sync server in ~30 lines. No ORM, no database — just plain types and an in-memory Map.

### 1. Define your schema

```ts
// schema.ts
import { defineSyncQueries, t } from "reflectdb/core";

export type Todo = {
  id: string;
  title: string;
  done: boolean;
  createdAt: Date;
};

export const queries = defineSyncQueries({
  todos: {
    row: t<Todo>(),
    conflict: "lww",
    serverSet: ["createdAt"],   // server always sets this, clients cannot
  },
});
```

### 2. Create the server

```ts
// server.ts
import { serve } from "bun";
import { createSyncServer } from "reflectdb/server";
import { createWsServerTransport } from "reflectdb/transport/ws";
import { queries, type Todo } from "./schema";

const todos = new Map<string, Todo>();
const transport = createWsServerTransport();

const server = createSyncServer({ queries, transport, serverId: "s1" });

server.auth(async (req) => {
  // validate req.headers.get("authorization")
  return { userId: "user-1" };
});

server.implement("todos", {
  query: () => [...todos.values()],
  mutate: async (op) => {
    if (op.type === "delete") todos.delete(op.rowId);
    else todos.set(op.rowId, { id: op.rowId, ...(op.payload as Partial<Todo>) } as Todo);
  },
  serverSet: { createdAt: () => new Date() },
});

// Wire WebSocket handlers to your HTTP server
serve({
  port: 3001,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/sync") {
      const clientId = crypto.randomUUID();
      if (srv.upgrade(req, { data: { clientId } })) return;
    }
    return new Response("ok");
  },
  websocket: {
    open(ws) { transport.handleOpen(ws.data.clientId, ws); },
    message(ws, data) { transport.handleMessage(ws.data.clientId, String(data)); },
    close(ws) { transport.handleClose(ws.data.clientId); },
    pong(ws) { transport.handlePong(ws.data.clientId); },
  },
});
```

### 3. Connect from the browser

```tsx
// app.tsx
import { SyncProvider, useSync, useSyncStatus } from "reflectdb/react";
import { createIndexedDBStorage } from "reflectdb/client/storage/indexeddb";

export function App() {
  return (
    <SyncProvider
      url="ws://localhost:3001/sync"
      token="..."
      tables={["todos"]}
      storage={createIndexedDBStorage({ dbName: "myapp" })}
    >
      <TodoList />
    </SyncProvider>
  );
}

function TodoList() {
  const { rows, insert, update, remove } = useSync("todos");
  const status = useSyncStatus();

  return (
    <div>
      <p>Status: {status}</p>
      {rows.map((t) => (
        <label key={t.id}>
          <input type="checkbox" checked={t.done} onChange={() => update(t.id, { done: !t.done })} />
          {t.title}
          <button onClick={() => remove(t.id)}>x</button>
        </label>
      ))}
      <button onClick={() => insert(crypto.randomUUID(), { title: "New", done: false })}>
        Add
      </button>
    </div>
  );
}
```

Open two tabs — edits in one appear in the other within a round-trip. Close the laptop, edit offline, reopen — pending ops replay automatically.

## Recipes

The repo ships two end-to-end examples: [`examples/whiteboard/`](./examples/whiteboard/), a collaborative drawing app with two modes (freeform and **Pictionary**), and [`examples/tetris/`](./examples/tetris/), one perpetual Tetris game with no player cap. Between them they exercise the patterns below in one place. The snippets here are minimal, copy-paste-friendly references; see the examples for how they fit together.

### WebSocket sync with SQLite + Drizzle

If you use Drizzle, point `table` at it and row types flow automatically. Swap the Map for `bun:sqlite` + Drizzle and add a persistent op log:

```ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { defineSyncQueries } from "reflectdb/core";
import { createSyncServer, createSqliteStorage } from "reflectdb/server";

const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

const queries = defineSyncQueries({
  todos: { table: todos, conflict: "lww", serverSet: ["createdAt"] },
});

const db = drizzle(new Database("app.db"));
const storage = createSqliteStorage({ path: "sync.db" });

const server = createSyncServer({ queries, db, transport, storage, serverId: "s1" });

server.implement("todos", {
  query: (_ctx, db) => db.select().from(todos),
  mutate: async (op, _ctx, db) => {
    if (op.type === "delete") {
      await db.delete(todos).where(eq(todos.id, op.rowId));
    } else {
      await db.insert(todos)
        .values({ id: op.rowId, ...op.payload })
        .onConflictDoUpdate({ target: todos.id, set: op.payload });
    }
  },
  serverSet: { createdAt: () => new Date() },
});
```

### Typed params for multi-tenant queries

Declare query params with `t<T>()` so the client must pass them and the server can use them to scope queries:

```ts
import { defineSyncQueries, t } from "reflectdb/core";

type Post = { id: string; title: string; orgId: string };

const queries = defineSyncQueries({
  posts: {
    row: t<Post>(),
    params: t<{ orgId: string }>(),
    tables: ["posts"],          // change-detection hint for delta computation
    pk: "id",
    conflict: "lww",
    readonly: ["orgId"],        // clients cannot write this
  },
});

// server
server.implement("posts", {
  query: (ctx, kyselyDb) =>
    kyselyDb.selectFrom("posts").where("orgId", "=", ctx.params.orgId).selectAll().execute(),
  mutate: async (op, ctx, kyselyDb) => { /* ... */ },
});

// client
client.sync("posts", { orgId: "org-42" });
```

Works with any ORM or raw driver.

### Authentication and room-based access control

`auth()` runs on every connection. Return an `AuthContext` — anything with a `userId`. It's passed to every `query`, `mutate`, and `authorize` call.

```ts
server.auth(async (req) => {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  const session = await validateToken(token);
  if (!session) throw new Error("unauthorized");
  return { userId: session.userId, orgId: session.orgId };
});
```

For multi-tenant apps, use `room()` to pin a client to a subset of data:

```ts
server.room("org/:orgId", async ({ params, auth }) => {
  if (!auth.memberships.includes(params.orgId)) {
    return { ok: false, reason: "not a member of this org" };
  }
  // return nothing (or `{ ok: true }`) to allow the subscription
});
```

Room keys are resolved from the subscription's params and fail closed: params that
address a pattern only partially, or that produce a key the pattern can't match, are
rejected rather than falling back to an unscoped, cross-room subscription. Set
`room` in `implement()` to require a specific pattern for a query.

The whiteboard example wires this up with [better-auth](https://better-auth.com) — see [`examples/whiteboard/auth.ts`](./examples/whiteboard/auth.ts).

### Per-column merge for collaborative editing

When two users edit different fields of the same row, `lww` would throw one write away. `merge` keeps both:

```ts
const queries = defineSyncQueries({
  docs: { row: t<Doc>(), conflict: "merge" },   // per-column HLCs
});
```

```
User A writes { title: "Hello" } at HLC 100
User B writes { body: "world" }  at HLC 200
→ Result: { title: "Hello", body: "world" }   (both accepted)
```

### Custom conflict resolvers

For domain logic — counters, highest-bid-wins, append-only lists — supply a resolver:

```ts
const queries = defineSyncQueries({
  auctions: {
    row: t<Auction>(),
    conflict: {
      policy: "custom",
      resolve: (incoming, existing) => {
        const bid = (incoming.payload.bid as number) ?? 0;
        if (bid <= (existing.row?.bid as number ?? 0)) {
          throw new Error("bid too low");   // rejects the op
        }
        return { row: { ...existing.row, ...incoming.payload } };
      },
    },
  },
});
```

### Validating client payloads

`t<MyRow>()` is a **compile-time** phantom — it erases at runtime. reflectdb validates
protocol structure (an op's `payload` must be a non-array object or null) but never
its contents, so a client can send `{ title: 12345 }` or extra keys and they reach
your `mutate` untouched. `readonly` and `serverSet` strip named fields; they don't
type-check what's left.

Validate in `mutate`, with whatever library you already use — reflectdb has no opinion
and no dependency here:

```ts
import { z } from "zod";
import { MutationError } from "reflectdb/core";

const Todo = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  done: z.boolean(),
}).strict();               // reject unknown keys instead of passing them through

server.implement("todos", {
  query: (ctx, db) => db.select().from(todos),
  mutate: async (op, ctx, db) => {
    if (op.type === "delete") {
      await db.delete(todos).where(eq(todos.id, op.rowId));
      return;
    }
    // Updates carry a partial delta, not a whole row.
    const schema = op.type === "insert" ? Todo : Todo.partial();
    const parsed = schema.safeParse(op.payload);
    if (!parsed.success) {
      throw new MutationError("outside_shape", parsed.error.message);
    }
    await db.insert(todos).values({ id: op.rowId, ...parsed.data })
      .onConflictDoUpdate({ target: todos.id, set: parsed.data });
  },
});
```

Two details that matter:

- **Throw `MutationError`, not a plain `Error`.** Only `MutationError` carries an
  `ErrorReason` through to the client's `onError`; anything else is reported as
  `server_error`.
- **Write the parsed value, not `op.payload`.** Writing the raw payload after
  validating it defeats `.strict()` and any coercion the schema applied — and it
  also feeds unvalidated data into reflectdb's mirror, which is what conflict
  resolution compares against.

The same applies to `authorize`, and to writes arriving through `server.rest()` —
both run the identical pipeline.

### Ephemeral messages (cursors, presence, typing)

Ephemeral events are room-scoped broadcasts that bypass the op log — ideal for high-frequency signals:

```tsx
import { useEphemeral } from "reflectdb/react";

const { events, broadcast } = useEphemeral({
  key: "cursor",
  userId: currentUserId,
  ttlMs: 10_000,
});

// on mouse move
broadcast({ x: e.clientX, y: e.clientY });

// render peers
Object.values(events).map((c) => <Cursor x={c.x} y={c.y} />);
```

Fan-out follows the sender's **query subscriptions**: recipients are the clients
subscribed to the same queries, narrowed to the sender's room when one is resolved. A
client that has called no `sync()` yet has no audience, so its ephemeral messages reach
nobody. The `userId` on the wire is always the authenticated one — the client-supplied
value is ignored — and a client-supplied `ttlMs` is clamped server-side.

Subscribing to a room also delivers a **snapshot** of that room's live ephemeral
state, so a client that joins mid-session sees the peers already there instead of
waiting for each one to move again. Snapshots arrive as ordinary `ephemeral` events
and exclude the joiner's own entries.

By default this state lives in the server process, which is correct on one node
and invisible across a fleet — two clients on different instances never see each
other. Point `ephemeral.adapter` at shared infrastructure to fix both halves; see
[Ephemeral (presence)](#ephemeral-presence).

The whiteboard renders peer cursors this way — see [`examples/whiteboard/app.tsx`](./examples/whiteboard/app.tsx).

### Typed presence

`presence()` is `useEphemeral` with the shape declared in the schema instead of at the
call site. The channel key is derived from the entry name plus its serialized params, so
two components watching the same presence entry always agree on the key.

```ts
// schema.ts
import { defineSyncQueries, presence, t } from "reflectdb/core";

export const queries = defineSyncQueries({
  cursor: presence({
    state: t<{ x: number; y: number; name: string }>(),
    params: t<{ gameId: string }>(),   // part of the derived key
    ttlMs: 10_000,
  }),
});
```

```tsx
// app.tsx — usePresence comes from the typed factory, not the bare import
import { createSyncReact } from "reflectdb/react";
import { queries } from "./schema";

export const { SyncProvider, useSync, usePresence } = createSyncReact(queries);

function Cursors({ gameId }: { gameId: string }) {
  const { peers, set } = usePresence("cursor", { gameId });
  //      ^? { userId: string; state: { x, y, name } }[]

  useEffect(() => {
    const onMove = (e: PointerEvent) =>
      set({ x: e.clientX, y: e.clientY, name: myName });
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [set]);

  return peers.map((p) => <Cursor key={p.userId} {...p.state} />);
}
```

Details worth knowing:

- **No server registration.** Presence entries are not queries — there is no
  `server.implement`/`server.view` for them. They ride the same ephemeral channel and
  are room-scoped by the sender's active subscriptions.
- **`peers` excludes you.** Ephemeral events are only delivered to *other* clients, so
  render your own cursor from local state.
- **Peers are keyed by connection, not by account.** Presence entries are keyed by
  `clientId` end to end — on the wire, in the server's store, and in `peers` — so two
  tabs from one login are two peers with two cursors. Put the display identity in
  `state` (as `name` above) if you need it; the authenticated `userId` rides along on
  every event for authorization and display.
- **Params are required when declared**, exactly like `useSync` — `usePresence("cursor")`
  fails to compile if the entry declares params.
- **React only.** `createSyncSvelte` / `createSyncVanilla` have no presence helper; use
  `sync.sendEphemeral` / `sync.onEphemeral` (or the store's `ephemeral()`) with your own
  key there. `derivePresenceKey(name, params)` is exported from `reflectdb/react` if you
  want to interoperate with the same channel by hand.

### Per-user query results

A `query` callback is just a function — it can return different rows depending on the caller's `auth`. reflectdb re-runs it whenever the listed `tables` change, so each subscriber gets a personalized view that stays live.

The whiteboard uses this to keep the round's secret word out of the wire for everyone except the active drawer:

```ts
const queries = defineSyncQueries({
  roundWord: {
    row: t<{ id: string; gameId: string; word: string }>(),
    params: t<{ gameId: string }>(),
    tables: ["games", "game_secrets"], // re-run on these
  },
});

server.implement("roundWord", {
  query: async (ctx, db) => {
    const game = await db.select().from(games).where(eq(games.id, ctx.params.gameId)).get();
    if (!game || game.state !== "drawing") return [];
    if (game.currentDrawerId !== ctx.auth.userId) return [];   // guessers see []
    const secret = await db.select().from(gameSecrets)
      .where(eq(gameSecrets.gameId, ctx.params.gameId)).get();
    return secret?.word ? [{ id: ctx.params.gameId, gameId: ctx.params.gameId, word: secret.word }] : [];
  },
  mutate: async () => { throw new Error("read-only"); },
  tables: ["games", "game_secrets"],
});
```

The `game_secrets` table isn't registered in `defineSyncQueries`, so it's never broadcast directly. Calling `server.notifyChange("game_secrets")` from the engine fans out the recomputed `roundWord` result to whichever client is now the drawer.

### Read-only views

The recipe above is a query that happens to reject writes. `view()` makes that the
declaration: the entry has no `mutate`, `useSync(...)` returns only `{ rows, loading }`,
and a write that reaches the server anyway is rejected with `readonly_query`.

```ts
// schema.ts
import { defineSyncQueries, view, t } from "reflectdb/core";

export const queries = defineSyncQueries({
  leaderboard: view({
    row: t<{ id: string; name: string; points: number }>(),
    params: t<{ gameId: string }>(),
    deps: ["games", "scores"],   // re-run when either table changes
  }),
});
```

```ts
// server.ts — server.view, not server.implement
server.view("leaderboard", (ctx, db) =>
  db.select().from(scores)
    .where(eq(scores.gameId, ctx.params.gameId))
    .orderBy(desc(scores.points))
    .limit(10));
```

```tsx
// app.tsx
const { rows } = useSync("leaderboard", { params: { gameId } });
// rows: { id, name, points }[] — there is no .insert / .update / .remove here
```

Notes:

- **`deps` drives change detection**, falling back to `tables` and then to the entry
  name. A view over tables it doesn't share a name with must declare them, or it never
  re-broadcasts.
- **`implement()` and `view()` are not interchangeable.** Calling `server.implement` on a
  name declared as a view throws, and so does `server.view` on a name that isn't one.
- **`server.view(name, fn)` takes no options** — only the callback and the schema's
  dependency list. There is no `authorize`, `room`, `groupBy`, `count`/`countHints` or
  `pk` on a view. Do access control inside the callback (it gets `ctx.auth` and
  `ctx.params`), and fall back to a regular `implement()` with a throwing `mutate` when
  you need those knobs.
- **Rows need an `id`.** The primary key isn't configurable for views, so give each row a
  stable `id` — that's what delta diffing keys on. Computed rows can synthesize one.
- **The type-level block is React-only.** `createSyncSvelte` / `createSyncVanilla` don't
  narrow view entries, so a write there compiles and is refused at runtime instead.

### Server-driven game loops

Some apps need state that advances on a clock, not on user input — round timers, expiring claims, scheduled rotations. Pair `server.interval` with `notifyChange` and the server stays the single source of truth.

```ts
server.interval(500, () =>
  server.lock("tick", async () => {          // a tick must never outrun itself
    const now = Date.now();
    const active = await db.select().from(games).where(eq(games.mode, "pictionary"));
    for (const g of active) {
      if (g.state === "drawing" && now >= g.roundEndsAt) {
        await endRound(g.id);                // raw SQL writes
        await server.notifyChange("games");  // fan-out to subscribers
      }
    }
  }),
);
```

`server.interval(ms, fn)` and `server.timeout(ms, fn)` wrap the globals with three
differences worth having: a throw or a rejected promise inside `fn` is caught and logged
instead of taking the process down, the handle is cleared by `server.close()`, and it is
disposed on `bun --hot` reload — so an edit-save loop doesn't leave a fleet of orphaned
timers ticking against the same rows. Both return `{ clear() }`.

`server.lock(key, fn)` serializes async work per key: calls queue and run one at a time,
and a failure in one doesn't poison the queue behind it. `server.tryLock(key, fn)` is the
skip-if-busy variant — it returns `null` immediately when the key is held, which is
usually what you want for a tick that would otherwise pile up.

```ts
const result = await server.tryLock(`game:${gameId}`, () => scoreRound(gameId));
if (result === null) return;   // another call is already scoring this game
```

Both are in-process only. Across instances, keep the guard in the database (a
conditional `UPDATE … WHERE state = 'drawing'` that returns rows-affected) — the lock
protects a single Node/Bun process, not a cluster. The whiteboard example uses both —
see [`examples/whiteboard/server.tsx`](./examples/whiteboard/server.tsx).

### Transactional writes with `server.tx`

`notifyChange` per table gets tedious the moment one logical action touches three of
them. `server.tx` runs the work, tracks which tables it wrote, and fires one
`notifyChange` per touched table — only if the whole function succeeded.

```ts
await server.tx(async (tx) => {
  await tx.update(games).set({ state: "scoring" }).where(eq(games.id, gameId));
  await tx.insert(scores).values(rows);
  await tx.delete(guesses).where(eq(guesses.gameId, gameId));
});
// → games, scores and guesses each broadcast once, after COMMIT
```

- **Atomic by default.** `atomic: true` is the default: the body runs inside
  `BEGIN`/`COMMIT` and rolls back on throw. It resolves an adapter from
  `ServerConfig.txAtomic`, falling back to a bundled Drizzle adapter (lazy-loaded, so
  there's no top-level `drizzle-orm` dependency). With neither available it throws —
  pass `atomic: false` for a non-transactional group, or supply your own adapter with
  `server.tx({ atomic: myAdapter }, fn)`.
- **Table tracking is automatic for Drizzle only.** The proxy watches
  `insert` / `update` / `delete` (`select` is not a write, so it doesn't count). On
  Kysely, Prisma or raw SQL, call `tx.touch("games")` after each write.
- **Notifies never fire on a throw**, transactional or not.
- **Pooled connections need care.** `BEGIN`/`COMMIT` and the writes must share one
  connection, so pass a single-connection handle when atomicity is load-bearing rather
  than a pool.

For a single row there is `server.emit(table, payload)`. It generates a rowId, stamps an
HLC, writes reflectdb's mirror plus the op-log entry, and broadcasts:

```ts
const { rowId, hlc } = await server.emit("todos", { title: "filed by a cron", done: false });
await server.emit("todos", { done: true }, { rowId, type: "update" });
```

It does **not** call your `implement`'s `mutate`, so it does not write your database.
That makes it the right tool when reflectdb's own store is what your `query` reads, and
the wrong one when your database is — a broadcast re-runs the query, so a row your
database never received simply won't appear. When your write has to happen under the
same stamp, use the primitive `emit` and `server.rest()` are both built on:

```ts
await server.applyServerOp(
  { type: "insert", table: "todos", rowId, payload },
  async (stamped) => {                       // runs before the mirror write
    await db.insert(todos).values({ id: stamped.rowId, ...stamped.payload });
  },
  { roomKey: `org/${orgId}` },               // keep the fanout inside the tenant
);
```

A throw inside `execute` aborts before anything touches the mirror or the op log. Omit
`roomKey` and the broadcast reaches every subscriber of the affected query, across rooms.

### Windowed sync and pagination

For large tables, sync a sliding window instead of the whole set:

```ts
const queries = defineSyncQueries({
  messages: {
    row: t<Message>(),
    conflict: "lww",
    countHints: true,   // emit count_changed deltas
  },
});

// React
const { rows } = useSync("messages", { window: 50 });
const total = useTotalCount("messages");
const loadMore = useLoadMore("messages");

// show "Load 50 more" when rows.length < total
```

Make the window a **real** limit by reading `ctx.limit` in the query and supplying a `count`:

```ts
server.implement("messages", {
  query: ({ params, limit }, db) =>
    db.select().from(messages)
      .where(eq(messages.roomId, params.roomId))
      .orderBy(desc(messages.createdAt))
      .limit(limit ?? 1000),
  count: async ({ params }, db) =>
    (await db.select({ n: count() }).from(messages)
      .where(eq(messages.roomId, params.roomId)))[0].n,
});
```

Without them, the server fetches every matching row on every broadcast and slices in JS — pagination reduces bytes on the wire and nothing else. `ctx.limit` is `undefined` when the caller genuinely needs the full set, so a plain `limit ?? <max>` is safe.

A window is an **entitlement**, not a row count: a subscriber with `window: 50` whose query matched 3 rows still receives the next 47 inserts, and `loadMore(20)` widens the entitlement by 20 regardless of how many rows actually arrived. Reconnecting restores the widened window, not the initial one.

### Auto-generated REST API

`server.rest()` returns a fetch-style handler that responds to CRUD URLs derived from your schema:

```ts
const rest = server.rest({ prefix: "/api" });

serve({
  port: 3001,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return rest(req);
    // ...WebSocket upgrade, etc.
    return new Response("ok");
  },
});
```

Endpoints generated for every `implement()`'d table:

```
GET    /api/<table>            → list (supports ?where=…&limit=&offset=)
GET    /api/<table>/:id        → single row
POST   /api/<table>            → insert (body = row, or array = batch)
PATCH  /api/<table>/:id        → update
DELETE /api/<table>/:id        → delete
```

REST writes go through the same pipeline as sync writes and broadcast deltas to connected clients.

### High availability with Postgres

Share a Postgres op log between server instances. Clients reconnecting to a different instance resume seamlessly from their HLC watermark.

```ts
import pg from "pg";
import { createPostgresStorage } from "reflectdb/server";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const server = createSyncServer({
  queries, db, transport,
  storage: createPostgresStorage(pool),
  serverId: process.env.FLY_ALLOC_ID,
  poll: 500,   // 500ms cross-instance poll for active-active
});
```

| Mode | Config | Use case |
|------|--------|----------|
| **Failover only** | Shared Postgres, no `poll` | Clients resume on reconnect |
| **Active-active** | Shared Postgres + `poll: 500` | Real-time cross-instance updates |

Each poll tick first probes the shared op log's head HLC; an idle tick costs one `MAX(hlc)` query and broadcasts nothing. Only tables that actually changed are re-broadcast. The tick also re-merges the shared clock watermark, so an instance whose wall clock lags its peers stops stamping writes below HLCs clients have already seen.

## Whiteboard + Pictionary example

A complete React + Bun + Drizzle app that exercises most of reflectdb in one
place: [`examples/whiteboard/`](./examples/whiteboard/). It is deployed at
[reflectdb-whiteboard.fly.dev](https://reflectdb-whiteboard.fly.dev/).

```bash
cd examples/whiteboard
bun install
bun dev
# open http://localhost:3003 in two tabs
```

Two modes:

- **Freeform draw** — every player can draw on a shared canvas. Strokes are LWW per row.
- **Pictionary** — players take turns drawing while the others guess in chat. The server picks a word, runs a per-round timer, awards points based on remaining time, advances the drawer, and ends the game after N full rotations.

Rooms are ephemeral: 30 minutes after a room is created, a server-side sweep
deletes it together with every stroke, chat line, player row and round secret
belonging to it. Both tabs bounce back to the lobby when it happens.

What it demonstrates:

| Pattern | Where |
|---------|-------|
| Drizzle-typed schema, SQLite op log | [`schema.ts`](./examples/whiteboard/schema.ts) |
| WebSocket transport on Bun | [`server.tsx`](./examples/whiteboard/server.tsx) |
| Guest-only authentication via better-auth's anonymous plugin | [`auth.ts`](./examples/whiteboard/auth.ts) |
| `params`-scoped queries (`strokes`, `messages` per game) | [`server.tsx`](./examples/whiteboard/server.tsx) |
| Per-user query results — only the drawer receives the secret word | `roundWord` in [`server.tsx`](./examples/whiteboard/server.tsx) |
| Server-side game loop with a mutex + `notifyChange` | `tick`, `withLock` in [`server.tsx`](./examples/whiteboard/server.tsx) |
| Server-side guess detection (text replacement so the answer never broadcasts) | `mutateMessageWithGuesses` in [`server.tsx`](./examples/whiteboard/server.tsx) |
| `readonly` field enforcement to keep the engine state out of client hands | [`schema.ts`](./examples/whiteboard/schema.ts) |
| Ephemeral cursors per game, scoped via `key: \`cursor:${gameId}\`` | [`app.tsx`](./examples/whiteboard/app.tsx) |
| Per-table rate limiting (loose for strokes, tight for chat) | `server.rateLimit` in [`server.tsx`](./examples/whiteboard/server.tsx) |
| TTL sweep deleting whole rooms and their content out of band, with `notifyChange` turning it into client deletes | `sweepExpiredRooms` in [`schema.ts`](./examples/whiteboard/schema.ts) |
| One-Machine Fly.io deployment, prebuilt bundle and env-driven config | [`Dockerfile`](./examples/whiteboard/Dockerfile) / [`fly.toml`](./examples/whiteboard/fly.toml) / [`config.ts`](./examples/whiteboard/config.ts) |

The included Fly.io config runs on one auto-stopping 512 MB Machine; deploying
your own copy takes two commands, both covered in
[`examples/whiteboard/README.md`](./examples/whiteboard/README.md).

## Infinite Tetris example

One ongoing Tetris game with no player cap: [`examples/tetris/`](./examples/tetris/).
Every visitor gets a live 10×20 well and a random server-assigned name. Players join
and leave without rounds or rooms; top out and that player's score resets to zero
before a fresh run begins immediately.

```bash
cd examples/tetris
bun install
bun dev
# open http://localhost:3004 in two tabs — each tab is a player
```

Bun SQLite stores the authoritative wells and reflectdb sync log in one WAL
database. The included Fly.io config runs on one auto-stopping 256 MB Machine.

| Pattern | Where |
|---------|-------|
| Server-authoritative gravity — `server.interval` + `server.tryLock` | [`server.tsx`](./examples/tetris/server.tsx) |
| `groupBy` — one query execution for the global game instead of one per player | `players` in [`server.tsx`](./examples/tetris/server.tsx) |
| `serverSet` refreshing the player heartbeat | `players` in [`server.tsx`](./examples/tetris/server.tsx) |
| Read-only board, piece, random name, and score fields | [`schema.ts`](./examples/tetris/schema.ts) |
| Row ownership enforced with `MutationError` | `players.mutate` in [`server.tsx`](./examples/tetris/server.tsx) |
| `view()` leaderboard, recomputed from `players` | `standings` in [`server.tsx`](./examples/tetris/server.tsx) |
| Headless game rules and top-out reset tests | [`game.ts`](./examples/tetris/game.ts) / [`game.test.ts`](./examples/tetris/game.test.ts) |
| Bun SQLite persistence and restart tests | [`database.ts`](./examples/tetris/database.ts) / [`database.test.ts`](./examples/tetris/database.test.ts) |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SHARED CORE  (core/)                             │
│                                                                             │
│   defineSyncQueries({ ... })  ── one schema, shared by every layer          │
│                                                                             │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────────┐  │
│   │ types.ts     │  │ hlc.ts       │  │ schema.ts                        │  │
│   │ • SyncOp     │  │ • HLC        │  │ • SyncQueryDef                   │  │
│   │ • Messages   │  │ • send/recv  │  │ • InferRow / InferParams         │  │
│   │ • ErrorReason│  │ • pack/cmp   │  │ • t<T>() phantom helper          │  │
│   │ • Protocol   │  │              │  │ • ConflictPolicy                 │  │
│   └──────────────┘  └──────────────┘  └──────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────────────────┘
                ┌───────────────┴────────────────┐
                ▼                                ▼
┌───────────────────────────────────┐  ┌──────────────────────────────────────┐
│      SERVER  (server/)            │  │       CLIENT  (client/)              │
│                                   │  │                                      │
│  createSyncServer<TQueries>()     │  │  createSyncClient<TQueries>()        │
│   ├─ .implement(name, opts)       │  │   ├─ .sync(name, params?)            │
│   ├─ .view(name, fn)              │  │   ├─ .insert/.update/.delete         │
│   ├─ .auth(token → AuthContext)   │  │   ├─ .subscribe / .subscribeTable    │
│   ├─ .room(pattern, cb)           │  │   ├─ .getRows / .getRow / .getState  │
│   ├─ .rateLimit / .compaction     │  │   ├─ .loadMore / .getTotalCount      │
│   ├─ .rest({ prefix })            │  │   └─ .sendEphemeral / .subscribeEph. │
│   ├─ .notifyChange / .emit / .tx  │  │                                      │
│   ├─ .lock / .interval / .timeout │  │  Internal:                           │
│   └─ .close()                     │  │                                      │
│                                   │  │   • SyncClient (state machine)       │
│  Pipeline (per op):               │  │   • ClientStore (row cache + queue)  │
│   1. clock drift check            │  │   • OpCreator (HLC stamping)         │
│   2. rate limit (fail-open)       │  │                                      │
│   3. batch-size check             │  │  State machine:                      │
│   4. readonly enforcement         │  │   hydrating → disconnected →         │
│   5. serverSet injection          │  │   connecting → connected →           │
│   6. conflict resolution*         │  │   bootstrapping → synced             │
│                                   │  │  Storage adapters:                   │
│   (* skipped by eager modes)      │  │   • memory (ephemeral)               │
│                                   │  │   • indexeddb (persistent)           │
│  BroadcastEngine (per write):     │  │                                      │
│   group subscribers → run query   │  │                                      │
│   once per group → diff per       │  │                                      │
│   client → send → commit cache    │  │                                      │
│                                   │  │                                      │
│  Op log storage (optional):       │  │                                      │
│   • in-memory (default)           │  │                                      │
│   • sqlite (bun:sqlite)           │  │                                      │
│   • postgres (any pg-compatible)  │  │                                      │
└───────────────────────────────────┘  └──────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        TRANSPORT LAYER  (transport/)                        │
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐   │
│  │  WebSocket       │  │  SSE             │  │  Polling                 │   │
│  │  real-time       │  │  event-stream +  │  │  3 HTTP endpoints —      │   │
│  │  bi-directional  │  │  POST back-chan  │  │  works anywhere HTTP does│   │
│  └──────────────────┘  └──────────────────┘  └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                    FRAMEWORK BINDINGS  (react/, svelte/, vanilla/)          │
│                                                                             │
│   • createSyncReact(queries)   → typed hooks + <SyncProvider>               │
│   • createSyncSvelte(queries)  → typed Svelte stores                        │
│   • createSyncVanilla(queries) → typed callback API                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Hybrid Logical Clocks

reflectdb uses [hybrid logical clocks](https://muratbuffalo.blogspot.com/2014/07/hybrid-logical-clocks.html) (HLCs) to order events across machines without requiring synchronized clocks.

An HLC has three parts:

| Component | Purpose |
|-----------|---------|
| `ms`      | Physical wall time |
| `counter` | Logical counter (breaks ties) |
| `nodeId`  | Machine that generated it |

HLCs pack to zero-padded strings (`0000001711234567890.0003.client-abc`), so **string comparison gives correct causal ordering** — no parsing needed. Conflict resolution is essentially free.

Two operations define the clock:

- **send** (`sendHlc`): advance `max(wall, lastMs)`; increment counter on tie, else reset.
- **receive** (`receiveHlc`): advance past both local and remote state. Remote timestamps are clamped to `wall + MAX_CLOCK_DRIFT_MS` (default 5 min) so a runaway client can't push the clock into the future.

The clock **ratchets forward** through every exchange, so causal ordering is preserved across the network.

### Conflict Resolution

Four built-in policies, chosen per-query:

```ts
defineSyncQueries({
  posts:  { row: t<Post>(),   conflict: "lww" },
  docs:   { row: t<Doc>(),    conflict: "merge" },
  config: { row: t<Config>(), conflict: "server" },
  scores: { row: t<Score>(),  conflict: { policy: "custom", resolve: fn } },
});
```

| Policy  | Granularity | Concurrent edits to different fields | Use case |
|---------|-------------|--------------------------------------|----------|
| `lww`   | Row         | One wins, the other is lost          | Simple data, rare conflicts |
| `merge` | Column      | Both preserved                        | Collaborative editing |
| `server`| Row         | Only first write; all others rejected | Config, reference data |
| custom  | You choose  | Your logic                            | Counters, "highest bid wins", business rules |

A custom resolver receives the incoming op, the existing row + per-column clocks, and metadata, and returns the resolved row. Throw to reject.

`merge` is a **server-side** guarantee: the server resolves per column using the client op HLCs held in its mirror, so two clients editing different fields both land. The per-column clocks a client sees on a broadcast are a different domain — a diff-driven broadcast can't attribute a column to the op that produced it, so every column changed in one broadcast carries that broadcast's HLC. Client-side merge orders *broadcasts* against each other and against local optimistic state; it does not reconstruct per-column causality between clients.

Both eager broadcast modes skip conflict resolution entirely — writes land last-writer-wins regardless of the declared policy.

### The Sync Protocol

```
1.  client ──▶ hello              server ──▶ hello_ack (protocol, serverId)
2.  client ──▶ sync_declare       server ──▶ snapshot / bootstrap_complete
3.  client ──▶ ops (optimistic)   server runs pipeline
4.                                server ──▶ ack / reject
5.                                server ──▶ delta (broadcast to subscribers)
6.  client reconnects ──▶ resume (watermark HLC)   server ──▶ missed deltas
```

All messages are JSON; the transport is just a pipe. WebSocket gives bi-directional real-time; SSE gives server-push with POST for upstream; polling is stateless HTTP for constrained environments.

### Two stores, one sync

reflectdb keeps its own store alongside yours, and it helps to know which one answers what:

| Read | Source |
|------|--------|
| Snapshots (`bootstrap`, `resume`) | **Your database**, via the `query` callback |
| Broadcast deltas | **Your database**, diffed against a per-client cached result set |
| Conflict resolution (`lww` / `merge` / `server` / custom) | **reflectdb's mirror** — a JSONB row store plus per-column HLCs |
| Which tables changed since an HLC | **reflectdb's op log** |

A write therefore lands in two places: your `mutate` callback commits to your database, and reflectdb commits the mirror row plus its op-log entry. Those are **separate commits** — "atomic" in this codebase means the mirror row and its op-log entry commit together, not that they commit with your write. Consequences worth designing around:

- A crash between the two leaves your database ahead of the mirror. Clients still converge (snapshots come from your database), but conflict resolution decides against slightly stale state until the next write.
- If `mutate` transforms the payload, or database defaults/triggers rewrite it, or something writes the table out of band, the mirror drifts from what clients actually see. Keep `mutate` a faithful application of `op.payload` when conflict policy is load-bearing, and route out-of-band writes through `server.applyServerOp` / `server.emit` / `server.tx`.

### The Op Log and Resume

Every accepted mutation is appended to the server's op log with its HLC. On reconnect, the client sends its last seen HLC as a watermark, and the server replays only what the client missed. This makes cross-server failover automatic when the log is shared (Postgres).

Old ops are compacted on a schedule based on client inactivity and minimum op age. Reconnecting clients whose watermark has been compacted receive a fresh bootstrap.

## API Reference

### `reflectdb/core`

```ts
import {
  defineSyncQueries, t, view, presence,
  createHlc, sendHlc, receiveHlc, packHlc, unpackHlc, compareHlc,
  MutationError, TransportSendError, isErrorReason, reasonFromError,
  PROTOCOL_VERSION, MAX_CLOCK_DRIFT_MS, MAX_BATCH_SIZE,
  TOMBSTONE_RETENTION_MS, SERVER_TOMBSTONE_RETENTION_MS,
} from "reflectdb/core";
```

| Export | Description |
|--------|-------------|
| `defineSyncQueries(map)` | Identity function that pins your schema's literal types. Feed its result to both server and client. |
| `t<T>()` | Phantom helper to declare a row or params type. Returns `undefined as T`. |
| `view({ row?, params?, deps?, tables? })` | Declare a read-only computed query. Registered with `server.view()`; writes are blocked at the type level and rejected at runtime. See [Read-only views](#read-only-views). |
| `presence({ state?, params?, ttlMs? })` | Declare a typed ephemeral channel. Read with `usePresence()` from `createSyncReact`. See [Typed presence](#typed-presence). |
| `createHlc(nodeId)` / `sendHlc` / `receiveHlc` | HLC constructors and transitions. |
| `packHlc` / `unpackHlc` / `compareHlc` | Serialize, deserialize, compare HLC values. |
| `MutationError(reason, message?)` | Throw from `mutate`/`authorize` to reject a write with a specific `ErrorReason`. |
| `TransportSendError(clientId, message)` | Throw from a custom `ServerTransport.send` when a frame did not reach the peer. |
| `isErrorReason(v)` / `reasonFromError(e)` | Validate / extract an `ErrorReason`. |

Types: `HLC`, `SyncOp`, `OpType`, `OpStatus`, `ClientMessage`, `ServerMessage`, `ErrorReason`, `ConflictPolicy`, `ConflictResolver`, `SyncQueryDef`, `SyncViewDef`, `SyncPresenceDef`, `SyncQueryEntry`, `SyncQueryMap`, `InferRow`, `InferState`, `InferParams`, `InferWritableRow`, `RequiresParams`, `RateLimitConfig`, `CompactionConfig`, `ShapeConfig`, `AuthContext`, `DrizzleTableLike`.

### `reflectdb/server`

```ts
import {
  createServer, createSyncServer,
  createSqliteStorage, createPostgresStorage,
  resolveConflict, processOp,
  enforceClockDrift, enforceReadonly, enforceServerSet, enforceBatchSize, createRateLimiter,
  MutationError,
} from "reflectdb/server";
```

**`createSyncServer<TQueries, TDb, TAuth>(config)`** — the typed entry point. Returns a server with:

| Method | Purpose |
|--------|---------|
| `.implement(name, options)` | Register a query handler (required for every regular query in the schema). |
| `.view(name, fn)` | Register a read-only query declared with `view()`. No `mutate`; writes reject with `readonly_query`. |
| `.auth(callback)` | Validate the connection request and return an `AuthContext`. |
| `.room(pattern, callback)` | Scope clients to a subset of data, matched against URL-style patterns (`org/:orgId`). Return `{ ok: false, reason }` to deny. |
| `.rateLimit(config)` | Set per-user/per-table limits. Fail-open on limiter errors. |
| `.compaction(config)` | Configure op-log compaction. |
| `.rest({ prefix })` | Generate a CRUD fetch handler. |
| `.minSchemaVersion(n)` | Reject clients on older schema versions. |
| `.notifyChange(table, roomKey?)` | Manually trigger a broadcast (for external writes). |
| `.emit(table, payload, opts?)` | Server-origin row write: stamps an HLC, writes the mirror + op log, broadcasts. Does not call your `mutate`. Returns `{ hlc, rowId }`. |
| `.applyServerOp(op, execute?, opts?)` | The primitive behind `emit` and `rest`. Hands the stamped HLC to `execute` before the mirror write; a throw aborts both. |
| `.tx(fn)` / `.tx(opts, fn)` | Run a write group in a transaction (`atomic: true` by default), tracking touched tables and firing one `notifyChange` each on success. |
| `.lock(key, fn)` | Serialize async work per key. `.tryLock(key, fn)` returns `null` instead of queueing when the key is held. |
| `.interval(ms, fn)` / `.timeout(ms, fn)` | Timers that log instead of crashing on a throw, and auto-dispose on `close()` and `bun --hot` reload. Return `{ clear() }`. |
| `.reserveOpId(id)` | Idempotency gate — `true` when the id is fresh. Used to dedupe REST retries. |
| `.runCompaction()` | Manually run one compaction pass. |
| `.close()` | Shut down, disconnect clients, clear timers, close storage. |

See [Server-driven game loops](#server-driven-game-loops) for `interval` / `lock`, and
[Transactional writes with `server.tx`](#transactional-writes-with-servertx) for `tx`,
`emit` and `applyServerOp`.

`createServer()` is the lower-level untyped variant — use it only if you need to register queries dynamically or don't have a `defineSyncQueries` map.

### `reflectdb/client`

```ts
import {
  createSyncClient,
  SyncClient,
  ClientStore,
  createMemoryStorage,
  createOpCreator,
} from "reflectdb/client";

import { createIndexedDBStorage } from "reflectdb/client/storage/indexeddb";
```

**`createSyncClient<TQueries>(config)`** — fully typed client. Methods:

| Category | Methods |
|----------|---------|
| Lifecycle | `init()`, `connect()`, `bootstrap()`, `resume()`, `push()`, `close()` |
| Subscriptions | `sync(name, params?)`, `unsync(name)` |
| Mutations | `insert(name, id, payload)`, `update(name, id, patch)`, `delete(name, id)`, `batch(ops)` |
| Reads | `getRows(name)`, `getRow(name, id)`, `getState()`, `getVersion()`, `getPendingCount()` |
| Observation | `subscribe(listener)`, `subscribeTable(name, listener)` (returns unsubscribe fn) |
| Windowing | `loadMore(name, count)`, `getTotalCount(name)` |
| Ephemeral | `sendEphemeral({ key, userId, data, ttlMs? })`, `subscribeEphemeral(key, listener)` |

State machine: `hydrating → disconnected → connecting → connected → bootstrapping → synced`. Reconnects with exponential backoff (capped by `maxReconnectDelayMs`, default 30s).

### `reflectdb/react`

```ts
import {
  SyncProvider, useSyncClient,
  useSync, useSyncStatus, useRow,
  usePendingCount, useEphemeral,
  useTotalCount, useLoadMore,
  createSyncReact, derivePresenceKey,
} from "reflectdb/react";
```

**`<SyncProvider>` props:**

| Prop | Type | Description |
|------|------|-------------|
| `url` | `string` | WebSocket URL (required) |
| `token` | `string` | Auth token passed to `server.auth()` (required) |
| `tables` | `string[]` | Tables to auto-sync on mount |
| `clientId` | `string` | Stable ID for this client (generated if omitted) |
| `storage` | `ClientStorageAdapter` | Defaults to memory |
| `onReauth` | `() => Promise<string>` | Called when server revokes auth |
| `onError` | `(e) => void` | Connection / sync error callback |

**Hooks:**

| Hook | Returns |
|------|---------|
| `useSync(table, options?)` | `{ rows, insert, update, remove, loading }` — options: `{ params?, includeDeleted?, window? }` |
| `useSyncStatus()` | `"hydrating" \| "disconnected" \| "connecting" \| "connected" \| "bootstrapping" \| "synced"` |
| `useRow(table, id)` | Single row or `null` |
| `usePendingCount()` | Total unsynced op count |
| `useEphemeral({ key, userId, ttlMs? })` | `{ events, broadcast }` |
| `useTotalCount(table)` | Server-side count (requires `countHints: true`) |
| `useLoadMore(table)` | Function to expand the sync window |

**`createSyncReact<TQueries>(queries)`** returns the same hook set with row and param
types inferred from your schema, plus two things the bare hooks can't provide:

| Hook | Returns |
|------|---------|
| `usePresence(name, params?)` | `{ peers, set }` for a `presence()` entry — `peers` is `{ userId, state }[]`, typed by the schema, and excludes you. Params are required when the entry declares them. |
| `useSync(viewName)` | `{ rows, loading }` for a `view()` entry — the mutators are absent from the type *and* stripped at runtime. |

`derivePresenceKey(name, params)` produces the same channel key `usePresence` uses, for
interoperating with `useEphemeral` or a non-React binding by hand.

### `reflectdb/svelte`

```ts
import { createSyncStore, createSyncSvelte, createBrowserWsTransport } from "reflectdb/svelte";
```

`createSyncStore(config)` returns a `SyncStore`:

```ts
const store = createSyncStore({ url, token, tables: ["notes"] });

const { rows, insert, update, remove } = store.sync<Note>("notes");
// rows is a Readable<Note[]> — subscribe with Svelte's $rows

store.status         // Readable<SyncClientState>
store.pendingCount   // Readable<number>

store.connect();
store.onStateChange((s) => …);
store.onError((e) => …);
```

`createSyncSvelte(queries)` returns fully-typed store factories.

### `reflectdb/vanilla`

```ts
import { createSync, createSyncVanilla, createBrowserWsTransport } from "reflectdb/vanilla";

const sync = createSync({ url, token, tables: ["notes"] });
const notes = sync.sync<Note>("notes");

notes.onChange((rows) => render(rows));
notes.insert(id, { title: "…" });

sync.onStateChange((s) => …);
sync.onPendingChange((n) => …);
sync.onError((e) => …);
sync.connect();
```

Also supports ephemeral: `sync.sendEphemeral({ key, userId, data })`, `sync.onEphemeral(key, listener)`.

### `reflectdb/transport/*`

```ts
import { createWsServerTransport, isOriginAllowed } from "reflectdb/transport/ws";
import { createBunWsServerTransport } from "reflectdb/transport/bun-ws";
import { createSseServerTransport } from "reflectdb/transport/sse";
import { createPollingServerTransport, pollingBodyTooLarge } from "reflectdb/transport/polling";
```

Each server transport returns a `ServerTransport` object plus framework-agnostic handlers (`handleOpen`, `handleMessage`, `handleClose`, `handlePong` for WS; `handleSubscribe`, `handleMessage`, `handleDisconnect`, `createEventStream` for SSE; `handleConnect`, `handlePoll`, `handleSend`, `handleDisconnect` for polling). Wire them to your HTTP server's routes — reflectdb does not ship a specific HTTP server.

`reflectdb/transport/bun-ws` is the same WebSocket transport shaped for `Bun.serve`: `createBunWsServerTransport()` returns `{ transport, websocket }`, where `websocket` is the handlers object you pass straight to `Bun.serve({ websocket })`. Use it only under Bun; `reflectdb/transport/ws` is the runtime-agnostic one.

Client-side, use the `createBrowserWsTransport(url)` helper exported from `reflectdb/svelte` or `reflectdb/vanilla`, or let `<SyncProvider>` create one internally.

## Configuration Reference

### Query definition

Every entry in `defineSyncQueries({ ... })`:

```ts
{
  // declare the row type — choose ONE:
  row: t<MyRow>(),                        // plain type (recommended default)
  // OR
  table: someDrizzleTable,                // auto-infers row type + table list + pk

  // optional:
  params: t<{ orgId: string }>(),         // typed query params (required on sync() if declared)
  tables: ["posts", "post_tags"],         // change-detection tables; defaults to the query key
  pk: "id",                               // primary-key column name (default "id")
  conflict: "lww",                        // "lww" | "merge" | "server" | { policy: "custom", resolve }
  readonly: ["createdBy"],                // fields the client cannot write
  serverSet: ["createdAt", "updatedAt"],  // fields the server always sets — required in `implement.serverSet`
  countHints: true,                       // emit count_changed deltas for windowed sync
}
```

`conflict` resolves the incoming op against **reflectdb's mirror** (its own JSONB row store and per-column clocks), not against your database. The two agree as long as every write goes through reflectdb and `mutate` persists the resolved payload verbatim — see [Two stores, one sync](#two-stores-one-sync).

A schema entry can also be a **view** or a **presence** channel instead of a regular
query. All three live in the same `defineSyncQueries({ ... })` map:

```ts
import { defineSyncQueries, t, view, presence } from "reflectdb/core";

export const queries = defineSyncQueries({
  todos:       { row: t<Todo>(), conflict: "lww" },  // regular  → server.implement()
  leaderboard: view({ row: t<Score>(), deps: ["scores"] }),   // → server.view()
  cursor:      presence({ state: t<{ x: number; y: number }>() }),  // → no server call
});
```

### View definition

```ts
view({
  row: t<MyRow>(),               // row type (or omit for Record<string, unknown>)
  params: t<{ gameId: string }>(),// typed params, same rules as a query
  deps: ["games", "scores"],     // change-detection tables
  tables: ["scores"],            // fallback when `deps` is absent
})
```

`deps` → `tables` → the entry name, in that order, decides what re-runs the view. Views
have no `conflict`, `readonly`, `serverSet` or `pk` — they never accept a write.
Register with [`server.view(name, fn)`](#read-only-views); `server.implement` on a view
name throws.

### Presence definition

```ts
presence({
  state: t<{ x: number; y: number; name: string }>(),  // payload shape
  params: t<{ gameId: string }>(),                     // folded into the channel key
  ttlMs: 10_000,                                       // entry expiry; omit for none
})
```

Presence entries are ephemeral channels, not queries: there is nothing to register
server-side, nothing lands in the op log, and the fan-out is scoped by the sender's
active room. Read them with `usePresence` from `createSyncReact(queries)` — see
[Typed presence](#typed-presence).

### Server configuration

```ts
createSyncServer({
  queries,                     // from defineSyncQueries()
  db,                          // optional — anything you want handed to query/mutate callbacks
  transport,                   // ServerTransport (required)
  storage,                     // StorageAdapter (optional; defaults to in-memory op log)
  serverId: "server-1",        // unique within the deployment
  poll: 500,                   // ms — enable HA active-active polling
  maxConnectionsPerUser: 10,   // backpressure guard
  queryTimeoutMs: 5_000,       // abort a broadcast query that hangs (0 = disabled)
  maxBroadcastConcurrency: 8,  // subscriber groups queried in parallel per broadcast
  allowAnonymous: false,       // serve connections with no auth() callback
  onEvent: (event) => { … },   // lifecycle telemetry
});
```

A server with no `auth()` callback rejects the handshake — every message after `hello` would fail the authentication gate anyway. Pass `allowAnonymous: true` to serve unauthenticated clients; each session gets an `anon:<clientId>` identity.

### `implement()` options

```ts
server.implement("todos", {
  query: (ctx, db) => /* fetch rows — return anything iterable */,
  mutate: async (op, ctx, db) => { /* apply op.type/op.rowId/op.payload */ },
  authorize: async (action, ctx, db) => {
    // action.type is "read" | "write"
    // throw to deny
  },
  serverSet: { createdAt: () => new Date() }, // required if schema declares serverSet fields
  broadcast: "consistent",                    // "consistent" | "eager" | "eager-durable"
  flushInterval: 50,                          // ms, for eager broadcasting
  maxBufferSize: 100,                         // ops per eager batch
  tables: ["todos"],                          // override change-detection set
  count: (ctx, db) => db.count(…),            // total row count for windowed queries
  groupBy: ({ auth }) => String(auth.orgId),  // collapse subscribers into one query execution
  room: "org/:orgId",                         // require this room pattern on every subscription
});
```

`query` may return whatever your data layer hands back, including live objects
your own code mutates later — an in-memory store, a game loop, an ORM's tracked
entities. Change detection snapshots each row when it caches it, so mutating the
same object in place is still seen as a change. The snapshot is shallow: mutating
a *nested* object inside a row is not, so treat nested values as immutable
(replace them rather than editing in place).

`broadcast` modes:

- **`consistent`** (default): run the conflict pipeline, persist, then broadcast by diffing each subscriber's re-executed query result.
- **`eager-durable`**: skip conflict resolution; run `mutate`, persist to reflectdb's mirror atomically, then broadcast the delta directly. The recommended low-latency mode.
- **`eager`**: same, but the mirror write is batched in the background — a crash can lose it. Only safe when `mutate` is durable to your own database.

Both eager modes still enforce `readonly`, `serverSet`, clock drift, the batch cap and rate limits. What they skip is **conflict resolution**: a declared `conflict` policy does not apply and writes land last-writer-wins.

#### Scaling broadcasts with `groupBy`

A write re-executes each dependent query once per subscriber *group*. Groups default to `(auth, params, roomKey)`, so with per-user auth they collapse to roughly one per connected client — N clients means N query executions per write.

`groupBy` returns the coarser key a query actually depends on:

```ts
server.implement("posts", {
  query: ({ auth }, db) => db.select().from(posts).where(eq(posts.orgId, auth.orgId)),
  // Results depend only on orgId — every member of an org shares one execution.
  groupBy: ({ auth }) => String(auth.orgId),
});
```

Two clients sharing a key **must** be entitled to byte-identical rows. Collapsing clients that aren't leaks rows across the boundary.

### Rate limiting

```ts
server.rateLimit({
  opsPerSecond: 20,
  opsPerMinute: 600,
  batchesPerMinute: 120,
  perTable: {
    todos: { opsPerSecond: 10 },
  },
  ephemeralPerSecond: 60,   // presence/cursor ceiling per client (default 60; 0 disables)
});
```

The limiter is **fail-open**: if the limiter itself errors, ops still flow. Clients that exceed their limit receive `ErrorReason: "rate_limited"`.

Ephemeral messages are metered separately and **always** — even without a `rateLimit()` call — because each one fans out to every room subscriber, which makes an unmetered channel an amplification vector. Dropped messages surface as an `ephemeral_rate_limited` event on `onEvent`.

### Compaction

```ts
server.compaction({
  clientInactivityTimeout: "24h",  // clients idle longer are ignored
  interval: "1h",                  // compaction interval
  minOpAge: "5m",                  // don't compact ops younger than this
});
```

Durations accept `ms`, `s`, `m`, `h`, `d`.

### Client configuration

```ts
createSyncClient({
  queries,
  clientId: "browser-xyz",         // required; keep stable across reloads
  transport: createBrowserWsTransport("ws://…"),
  token: "auth-token",             // required
  storage: createIndexedDBStorage({ dbName: "app" }),
  autoSync: true,                  // auto-sync param-less queries on connect
  maxReconnectDelayMs: 30_000,
  hydrateAllTables: false,         // true = read every stored row at boot
  onSync: () => { … },             // fires once bootstrap completes
  onError: (e) => { … },
  onReauth: async () => newToken,  // called after "auth_revoked"
});
```

At boot the client restores its persisted subscriptions first and hydrates only those tables — rows only ever reach local storage through a subscription, so nothing reachable is skipped. Set `hydrateAllTables: true` if you read rows for a table before calling `sync()` on it.

### Storage adapters

#### Server op log

| Adapter | Import | Best for |
|---------|--------|----------|
| _(none)_ | omit `storage` | In-memory op log; ephemeral, single node |
| `createSqliteStorage({ path?, db? })` | `reflectdb/server` | Single server, development, embedded — **Bun only** |
| `createPostgresStorage(poolOrConfig)` | `reflectdb/server` | Multi-server HA, production |

`createPostgresStorage` accepts any object with `query(text, values) => { rows }` — `pg.Pool`, `pg.Client`, `@neondatabase/serverless`, etc. Optional config: `{ client, tablePrefix: "_reflectdb" }`.

`createSqliteStorage` is backed by `bun:sqlite` and is resolved lazily, so importing `reflectdb/server` on Node is fine — only calling `createSqliteStorage` there throws. On Node, use `createPostgresStorage` (or omit `storage` for the in-memory op log).

#### Client

| Adapter | Import | Best for |
|---------|--------|----------|
| `createMemoryStorage()` | `reflectdb/client` | Testing, SSR, short sessions |
| `createIndexedDBStorage({ dbName, version?, migrate? })` | `reflectdb/client/storage/indexeddb` | Production browser apps |

#### Ephemeral (presence)

Presence, cursors and typing indicators are stored separately from the op log —
they never durably persist, and they have their own adapter.

| Adapter | Import | Best for |
|---------|--------|----------|
| _(none)_ | omit `ephemeral` | In-process store; single node |
| `createRedisEphemeral({ client, subscriber?, prefix? })` | `reflectdb/server/ephemeral/redis` | Multiple instances behind a load balancer |

```ts
import { createRedisEphemeral } from "reflectdb/server/ephemeral/redis";
import Redis from "ioredis";

const commands = new Redis(process.env.REDIS_URL!);
// Subscribe mode blocks ordinary commands, so the bus needs its own connection.
const bus = new Redis(process.env.REDIS_URL!);

const server = createSyncServer({
  queries,
  db,
  transport,
  ephemeral: {
    adapter: createRedisEphemeral({
      client: commands,
      subscriber: {
        subscribe: (channel, onMessage) => {
          bus.on("message", (c, m) => { if (c === channel) onMessage(m); });
          return bus.subscribe(channel);
        },
      },
    }),
  },
});
```

`client` needs one method — `call(command, ...args)`, which `ioredis` has natively.
For node-redis or Bun, wrap it:

```ts
// node-redis
{ call: (cmd, ...args) => client.sendCommand([cmd, ...args.map(String)]) }
// Bun
{ call: (cmd, ...args) => client.send(cmd, args.map(String)) }
```

Options: `prefix` (default `reflectdb:eph`), `maxEntries` (default `100_000`,
fleet-wide), `hashTtlSeconds` (default 24h — a safety net so a crashed instance
can't strand entries forever). Omit `subscriber` to share state without a live
bus: peers then appear on join and after a sweep, but not as they move.

`ephemeral.maxEntries` on its own tunes the in-process store's ceiling
(default `10_000`) without swapping the adapter.

Implement `EphemeralAdapter` (from `reflectdb/server/ephemeral`) to back
presence with something else. `publish`/`subscribe` are optional — an adapter
without them is a shared store with no live bus.

### Transport configuration

#### WebSocket

```ts
createWsServerTransport({
  maxMessageBytes: 1_000_000,   // reject larger frames
  pingIntervalMs: 30_000,       // heartbeat; 0 disables
  pongTimeoutMs: 60_000,        // close half-open connections
  maxBufferedBytes: 8_000_000,  // outbound backpressure ceiling; 0 disables
});
```

Returns a `ServerTransport` plus `handleOpen`, `handleMessage`, `handleClose`, `handlePong`. Wire these to your HTTP server's WebSocket callbacks (see [Quick Start](#quick-start)). Use `isOriginAllowed(req, ["https://app.example"])` in your upgrade handler for CORS.

#### Server-Sent Events

```ts
createSseServerTransport({
  replayBufferSize: 256,        // Last-Event-ID replay window
});
```

Two endpoints to wire: `GET /sync/events/:clientId` (SSE stream) and `POST /sync/messages/:clientId` (client → server).

#### HTTP long-polling

```ts
createPollingServerTransport({
  maxQueueLen: 1000,
  idleTimeoutMs: 60_000,
  reaperIntervalMs: 30_000,
  maxMessageBytes: 1_000_000,
});
```

Three endpoints: `POST /sync/connect/:id`, `GET /sync/poll/:id`, `POST /sync/send/:id`. Use the `pollingBodyTooLarge()` helper in your request handler.

#### Writing your own transport

`ServerTransport.send` **must reject when the frame did not reach the peer** — unknown or closed socket, full outbound queue, backpressure limit. The broadcast engine treats a resolved `send` as "this delta landed" and only then commits the client's cached result set; a transport that swallows failures makes the server believe a client holds rows it never received, and the divergence persists until reconnect. Throw `TransportSendError` from `reflectdb/core` so callers can distinguish delivery failures from bugs.

## Development

### Prerequisites

- [Bun](https://bun.sh) 1.0+
- Node.js 22+ and npm — dev tooling, and `bun run verify:node`, which checks the published package works for Node consumers in both ESM and CommonJS

### Setup

```bash
git clone https://github.com/TimMikeladze/reflectdb.git
cd reflectdb
bun install
```

### Scripts

| Command | Description |
|---------|-------------|
| `bun test` | Run the full test suite |
| `bun test --watch` | Watch mode |
| `bun test --coverage` | Coverage report |
| `bun run build` | Build with `bunup` (ESM + types) |
| `bun run type-check` | TypeScript strict check |
| `bun run lint` | Lint with `oxlint` |
| `bun run format` | Format with `oxfmt` |
| `bun run verify:exports` | Check the `exports` map against `dist/`, and type-check the emitted declarations without ambient Bun/React globals (run after `build`) |
| `bun run verify:node` | Install the packed tarball into a throwaway Node project and check every subpath imports, requires, and type-checks there under both export conditions (run after `build`; needs `node` + `npm`) |

### Landing page and social cards

The site at [reflectdb.dev](https://reflectdb.dev) lives in `landing/`:

```bash
cd landing
bun install
bun run dev       # vite dev server
bun run og        # regenerate the social cards in landing/public
```

`bun run og` renders every card in `landing/og/` with your local Chrome (set
`CHROME_PATH` if it lives somewhere unusual) and writes the PNGs the pages
reference:

| Card | Output | Size | Used by |
|------|--------|------|---------|
| `og/index.html` | `public/og.png` | 1200x630 at 2x | reflectdb.dev |
| `og/tetris.html` | `public/og-tetris.png` | 1200x630 at 2x | the Tetris demo — served from reflectdb.dev, since the Fly Machine sleeps |
| `og/whiteboard.html` | `public/og-whiteboard.png` | 1200x630 at 2x | the whiteboard demo, served from reflectdb.dev for the same reason |
| `og/github.html` | `public/og-github.png` | 1280x640 at 2x | this repository's social preview, uploaded by hand under Settings → Social preview |

Edit the HTML, not the PNGs. 1200x630 is the one ratio X, Facebook, LinkedIn,
Slack, Discord, Telegram, Mastodon and iMessage all unfurl without cropping, and
each card has to stay under 300 kB or WhatsApp silently downgrades it to a small
thumbnail — the script renders at the largest scale factor that fits, and fails
if a card is oversized or the wrong shape.

#### Analytics

The site reports page views to a self-hosted [Umami](https://umami.is) instance,
and does so only when it is configured to. `landing/vite.config.ts` injects the
tag into `index.html` at build time from these variables — with the website id
unset, nothing is injected and the page makes no third-party request, so a local
dev server or a fork builds and runs untouched:

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `VITE_UMAMI_WEBSITE_ID` | yes, to enable | — | The site's id in Umami. Unset disables analytics entirely. |
| `VITE_UMAMI_SCRIPT_URL` | no | `https://linesofcode-umami.vercel.app/script.js` | The tracker script, if you host Umami elsewhere. |
| `VITE_UMAMI_DOMAINS` | no | — | Comma-separated hostnames to count. Set it to `reflectdb.dev` to keep preview deployments and localhost out of the numbers. |

They are read at build time, so changing one in the Vercel project takes effect
on the next deployment rather than the next request.

### Project Structure

```
src/
├── core/         HLC, types, schema
├── server/       createSyncServer, pipeline, session, handler
│   │             broadcast-engine, result-cache, eager-buffer,
│   │             compaction-manager, replay-detector, ephemeral-manager
│   └── storage/  SQLite + Postgres adapters
├── client/       sync-client, store, ops, typed-client
│   └── storage/  memory + IndexedDB adapters
├── transport/    WebSocket (runtime-agnostic + Bun.serve), SSE, polling
├── react/        <SyncProvider>, hooks, typed factory
├── svelte/       createSyncStore, typed factory
└── vanilla/      createSync, typed factory
```

### Tech stack

- Runtime: Bun
- Language: TypeScript (strict, ESM only)
- Build: bunup
- Test: `bun:test`
- Lint: oxlint
- Format: oxfmt
- CI: GitHub Actions (Ubuntu + macOS)

## License

MIT
