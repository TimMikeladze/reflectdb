# reflectdb presence service

**Live:** https://reflectdb-presence.vercel.app · `https://reflectdb-presence.vercel.app/api/presence`

A standalone presence backend — cursors, typing indicators, "who's here" — that
runs independently of reflectdb sync. Clients open one SSE stream per room and
POST their own state, which never persists.

It exists because presence is the part of realtime that is annoying to operate
rather than hard to write: shared state across instances, entries that must
disappear when a tab closes, and no place to put a connection.

```
┌──────────┐   GET /stream (SSE)   ┌──────────────────┐
│ Browser  │ ◀──────────────────── │  stream function │──┐
│  tab A   │ ────────────────────▶ │  publish/leave   │  │
└──────────┘   POST /publish       └──────────────────┘  │
                                                         │  poll + upsert
┌──────────┐                       ┌──────────────────┐  │
│ Browser  │ ◀──────────────────── │  stream function │──┤
│  tab B   │ ────────────────────▶ │  publish/leave   │  │
└──────────┘                       └──────────────────┘  │
                                                         ▼
                                              ┌─────────────────────┐
                                              │  Postgres           │
                                              │  presence_entry     │
                                              └─────────────────────┘
```

The two browsers are on different instances, and neither instance knows the
other exists. Everything they share, they share through one table.

## What it gives you

- **Snapshot on join** — a client that arrives late sees who is already there,
  instead of an empty room until every peer happens to move.
- **Prompt leave** — a closing tab beacons out, so its cursor goes without
  waiting for a TTL. Best-effort: see [What SSE costs](#what-sse-costs).
- **Fleet-wide rooms** — state lives in Postgres, so two clients served by
  different instances are in the same room.
- **Per-project limits** — client cap, write rate, room size, TTL ceiling.
- **Project isolation** — rooms are namespaced by project, so two customers with
  a room called `board-1` never meet.
- **No sockets** — which is what lets it run on Vercel, or anywhere else that
  charges by the request rather than by the connection.

## Protocol

Three HTTP calls. All bodies and frames are JSON.

| Client → server                                    | Purpose                                           |
| -------------------------------------------------- | ------------------------------------------------- |
| `GET /api/presence/stream?apiKey=&room=&clientId=` | Open the room stream.                             |
| `POST /api/presence/publish`                       | Set this client's state on a channel.             |
| `POST /api/presence/leave`                         | Drop one channel, or everything the client holds. |

The stream carries every server frame on the default SSE event, each a JSON
object with a `type`:

| Server → client | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `welcome`       | Stream accepted; echoes `clientId` and says how long it will last. |
| `snapshot`      | Everyone already in the room. Always follows `welcome`.            |
| `presence`      | A peer's state appeared or changed.                                |
| `leave`         | A peer's state went away — cleared, left, or expired.              |
| `error`         | Rejected. `fatal` means the stream is ending.                      |
| `bye`           | This stream reached its time limit and is closing normally.        |

Peer identity is the **client**, not the account: two tabs from one login are
two peers with two cursors.

`clientId` is minted by the client and kept for the tab, because a stream is not
a session — it ends about once a minute and the client opens another. A
server-assigned id would change on every one of those, and every peer would
watch the same person leave and rejoin all day.

## What SSE costs

Three things are genuinely weaker than they were over a WebSocket. All three are
consequences of having no connection, not of this implementation.

**Leave is announced, not detected.** Closing a socket told the server you were
gone. Closing a tab tells it nothing. The client sends a `leave` beacon on
`pagehide` — `navigator.sendBeacon`, the one send that survives a page teardown
— and the TTL covers the times it does not get out. A hard-killed browser or a
dropped network leaves a cursor until its TTL lapses.

**Updates arrive on a poll, not a push.** An open stream reads its room every
200ms while other people are in it, and every second while a client is alone.
That is the latency floor: a peer's cursor is up to a poll behind.

**Streams are recycled.** Serverless functions have a wall-clock ceiling, so the
server ends each stream deliberately at `PRESENCE_STREAM_MS` (55s by default)
with a `bye` rather than being cut off mid-frame. The client reopens at once,
keeping its `clientId` and republishing what it holds, so a recycle is invisible
— but it is a real reconnect, and a `snapshot` follows each one.

Rate limiting is also enforced differently, and better: the store refuses a
write that lands closer than `1000 / maxMessagesPerSecond` after the previous
one to the same entry. That is one statement rather than a shared counter, and
it is correct across the fleet — a per-instance token bucket would let a client
multiply its allowance by the number of instances it happened to reach.

## Client

```ts
// Not yet published as an npm subpath — copy it, or import from source.
import { createPresenceClient } from "./services/presence/client.ts";

const presence = createPresenceClient({
	url: "https://reflectdb-presence.vercel.app/api/presence",
	apiKey: import.meta.env.VITE_PRESENCE_KEY,
	room: "board-1",
	identity: { name: "Ada", color: "#f0f" },
	ttlMs: 30_000,
});

window.addEventListener("pointermove", (e) => {
	presence.publish("cursor", { x: e.clientX, y: e.clientY });
});

presence.subscribe<{ x: number; y: number }>("cursor", (peers) => {
	for (const peer of peers) {
		drawCursor(peer.clientId, peer.data, peer.identity);
	}
});
```

`url` is the base — the client appends `/stream`, `/publish` and `/leave`.

It reconnects with backoff, treats a scheduled recycle as free rather than
paying a backoff for it, replays what it had published, keeps at most one
request in flight per channel, and treats each `snapshot` as authoritative.

The landing page runs this client for real: the presence card on
[reflectdb.dev](https://reflectdb.dev) is not a screenshot but a live room every
visitor joins. Because that site deploys from `landing/` alone, it carries a
vendored copy at `landing/src/presence/` — update both together, or the copy
fails on the next protocol bump.

Two channels, not one: `cursor` carries pointer positions, and `here` is
published once on join and heartbeated, so the room can count people who are
present but have not moved. Counting `cursor` alone reports an empty room full
of readers.

## Configuration

| Variable                   | Default | Purpose                                 |
| -------------------------- | ------- | --------------------------------------- |
| `PRESENCE_DATABASE_URL`    | —       | Postgres connection string. Required.   |
| `PRESENCE_DATABASE_SSL`    | `false` | `true` to connect over TLS.             |
| `PRESENCE_PROJECTS`        | —       | Seed keys as JSON (see below)           |
| `PRESENCE_STREAM_MS`       | `55000` | How long one stream stays open          |
| `PRESENCE_FAST_POLL_MS`    | `200`   | Poll interval with peers in the room    |
| `PRESENCE_IDLE_POLL_MS`    | `1000`  | Poll interval with a client alone       |
| `PRESENCE_POOL_MAX`        | `3`     | Postgres connections per instance       |
| `PRESENCE_ALLOWED_ORIGINS` | `*`     | Comma-separated origins, or `*`         |
| `PRESENCE_STORE`           | —       | `memory` to run with no database at all |

API keys live in `presence_key`. `PRESENCE_PROJECTS` seeds them on first use
with `ON CONFLICT DO NOTHING`, so an existing row is never clobbered by a
redeploy — a control plane can own the same table later without changing this
service.

```json
{
	"pk_live_abc123": { "projectId": "acme", "maxConnections": 500 },
	"pk_test_xyz789": { "projectId": "acme-dev" }
}
```

Per-project fields, all optional: `maxConnections` (100), `maxMessagesPerSecond`
(30), `maxEntriesPerRoom` (200), `defaultTtlMs` (30000), `maxTtlMs` (300000).

`maxConnections` is approximate and always will be: there is no connection to
count, so occupancy is measured as distinct clients holding live state, which
counts a client that has gone away until its entries expire. A client already
inside the project is always readmitted, or a full project would evict its own
users as their streams recycled.

## Endpoints

- `GET /api/health` — pings the store; `503` when it is unreachable. Also
  reports what _this instance_ is holding. Two calls can land on different
  instances and disagree; that says the platform is running more than one.
- `GET /` — rewritten to `/api/health`.

## Running locally

No database:

```bash
PRESENCE_STORE=memory \
PRESENCE_PROJECTS='{"dev-key":{"projectId":"dev"}}' \
  bun services/presence/dev.ts
```

With one:

```bash
docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
PRESENCE_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
PRESENCE_PROJECTS='{"dev-key":{"projectId":"dev"}}' \
  bun services/presence/dev.ts
```

`dev.ts` serves the same routes through the same handlers Vercel serves; the
only difference is one process instead of many, which is the difference the
polling design was chosen to make invisible.

Point the landing page at it with
`VITE_PRESENCE_URL=http://localhost:8080/api/presence` and
`VITE_PRESENCE_KEY=dev-key`.

## Deploying to Vercel

One project, with **Root Directory** set to `services/presence`. Everything
under `api/` becomes a function; `vercel.json` raises the stream's
`maxDuration` and points `/` at the health endpoint.

```bash
cd services/presence
vercel link
vercel env add PRESENCE_DATABASE_URL production
vercel env add PRESENCE_PROJECTS production
vercel deploy --prod
```

The schema is created on first use — `CREATE TABLE IF NOT EXISTS`, no migration
step. Presence state is disposable by construction (every entry carries an
expiry, and clients republish within one TTL), so the database needs no
backups, no durability guarantees, and no restore plan.

### Sizing the database

Every warm instance keeps its own pool, so the fleet's connection count is
`PRESENCE_POOL_MAX` times however many instances the platform runs. On a small
Postgres, lower `PRESENCE_POOL_MAX` before raising anything else: presence
queries take milliseconds, so pool depth buys nothing.

Read load is one query per room per poll — _per room_, not per viewer. Ten
people on one instance watching one room cost one query per tick between them,
because a single `RoomWatcher` does the reading and fans out in process. Write
load is one upsert per publish.

### Why Postgres and not Redis

Presence is command-heavy and data-light: every cursor move is a write, and
every open stream is a read on a timer. Managed Redis is generally billed per
command, which makes that meter track mouse movement rather than anything a
customer values. One table on a Postgres you already run is a fixed cost.

The state is disposable either way, so nothing about the choice is a durability
argument. It is a billing one.

## Testing

```bash
bun test test/presence/
```

The store has one contract suite that runs against both implementations —
`createMemoryStore` always, and `createPostgresStore` when
`PRESENCE_TEST_DATABASE_URL` is set:

```bash
PRESENCE_TEST_DATABASE_URL=postgres://... bun test test/presence/
```

That suite is what keeps the memory store a faithful stand-in: expiry, the rate
refusal and the capacity refusal are all easy to get subtly different between a
`Map` and a SQL statement.
