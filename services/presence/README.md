# reflectdb presence service

**Live:** https://reflectdb-presence.fly.dev · `wss://reflectdb-presence.fly.dev/connect`

A standalone presence backend — cursors, typing indicators, "who's here" — that
runs independently of reflectdb sync. Clients connect over one WebSocket, join a
room, and exchange state that never persists.

It exists because presence is the part of realtime that is annoying to operate
rather than hard to write: thousands of long-lived sockets, shared state across
instances, and entries that must disappear the instant a tab closes.

```
┌──────────┐   wss    ┌─────────────────┐   pub/sub   ┌─────────────────┐
│ Browser  │ ───────▶ │  presence (sjc) │ ◀─────────▶ │  presence (iad) │
│  tab A   │          │   Machine 1     │             │   Machine 2     │
└──────────┘          └────────┬────────┘             └────────┬────────┘
                               │        Redis (state + bus)    │
                               └───────────────┬───────────────┘
                                               ▼
                                    ┌─────────────────────┐
                                    │  redis:7-alpine     │
                                    │  (private, no disk) │
                                    └─────────────────────┘
```

## What it gives you

- **Snapshot on join** — a client that arrives late sees who is already there,
  instead of an empty room until every peer happens to move.
- **Immediate leave** — closing a tab removes that cursor at once, rather than
  leaving a ghost until a TTL lapses.
- **Fleet-wide rooms** — state and fan-out both live in Redis, so two clients on
  different Machines are in the same room.
- **Per-project limits** — connection cap, publish rate, room size, TTL ceiling.
- **Project isolation** — rooms are namespaced by project, so two customers with
  a room called `board-1` never meet.

## Protocol

One WebSocket at `/connect`. All frames are JSON.

| Client → server | Purpose |
|---|---|
| `hello` | Authenticate and join a room. Must be first. |
| `publish` | Set this connection's state on a channel. |
| `clear` | Drop this connection's state on a channel. |
| `ping` | Keepalive. |

| Server → client | Purpose |
|---|---|
| `welcome` | Join accepted; carries the server-assigned `clientId`. |
| `snapshot` | Everyone already in the room. Always follows `welcome`. |
| `presence` | A peer published state. |
| `leave` | A peer disconnected, or cleared one channel. |
| `error` | Rejected frame. `fatal` means the socket is closing. |
| `pong` | Keepalive reply. |

Peer identity is the **connection**, not the account: two tabs from one login are
two peers with two cursors.

## Client

```ts
// Not yet published as an npm subpath — copy it, or import from source.
import { createPresenceClient } from "./services/presence/client.ts";

const presence = createPresenceClient({
  url: "wss://reflectdb-presence.fly.dev/connect",
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

The client reconnects with backoff, replays what it had published, and treats
each `snapshot` as authoritative for the room.

The landing page runs this client for real: the presence card on
[reflectdb.dev](https://reflectdb.dev) is not a screenshot but a live room every
visitor joins. Because that site deploys from `landing/` alone, it carries a
vendored copy at `landing/src/presence/` — update both together, or the copy
fails at `hello` on the next protocol bump.

Two channels, not one: `cursor` carries pointer positions, and `here` is
published once on join and heartbeated, so the room can count people who are
present but have not moved. Counting `cursor` alone reports an empty room full
of readers.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `REDIS_URL` | `redis://localhost:6379` | State and bus |
| `PRESENCE_PREFIX` | `presence` | Redis key prefix |
| `PRESENCE_PROJECTS` | — | Seed keys as JSON (see below) |

API keys live in Redis at `{prefix}:key:{apiKey}`. `PRESENCE_PROJECTS` seeds them
at boot with `HSETNX`, so an existing value is never clobbered by a redeploy —
a control plane can own the same hashes later without changing this service.

```json
{
  "pk_live_abc123": { "projectId": "acme", "maxConnections": 500 },
  "pk_test_xyz789": { "projectId": "acme-dev" }
}
```

Per-project fields, all optional: `maxConnections` (100), `maxMessagesPerSecond`
(30), `maxEntriesPerRoom` (200), `defaultTtlMs` (30000), `maxTtlMs` (300000).

## Endpoints

- `GET /` — service identity and the `wss://` URL to connect to
- `GET /health` — pings Redis; `503` when it is unreachable
- `GET /metrics` — connections, rooms, published frames, rejected frames

## Running locally

```bash
docker run -d --rm -p 6379:6379 redis:7-alpine
PRESENCE_PROJECTS='{"dev-key":{"projectId":"dev"}}' \
  bun services/presence/server.ts
```

## Deploying to Fly

Two apps: the service, and a Redis it talks to over the organization's private
network.

```bash
# 1. Redis — private-only, no volume (see below)
fly apps create reflectdb-presence-redis
fly secrets set REDIS_PASSWORD="$(openssl rand -hex 24)" \
  --app reflectdb-presence-redis --stage
cd services/presence/redis && fly deploy --ha=false && cd -

# 2. The service
fly apps create reflectdb-presence
fly secrets set \
  REDIS_URL="redis://default:<password>@reflectdb-presence-redis.internal:6379" \
  PRESENCE_PROJECTS='{"pk_live_...":{"projectId":"acme"}}' \
  --app reflectdb-presence --stage
fly deploy --config services/presence/fly.toml \
  --dockerfile services/presence/Dockerfile
```

The service's Dockerfile copies `src/` alongside `services/`, so it must build
from the repository root — hence the explicit `--config` / `--dockerfile` pair
rather than running `fly deploy` inside this directory.

### Why not managed Upstash Redis

Fly's managed Redis bills $0.2 per 100K commands. Presence is command-heavy and
data-light: every cursor move is a write plus a publish, so that meter tracks
mouse movement rather than anything a customer values. One `shared-cpu-1x`
Machine running `redis:7-alpine` is a fixed cost with no per-command billing,
and presence state is disposable — clients republish within one TTL of a
restart — so it needs no volume and no persistence.

`services/presence/redis/` holds that app. It binds `::` as well as `0.0.0.0`:
Fly's private network between apps is IPv6, and an IPv4-only bind leaves Redis
reachable from inside its own Machine and nowhere else.

### Scaling

`fly scale count 3`, or add regions. Every Machine shares the same Redis, so
rooms span the fleet with no further configuration — a client on one Machine
sees peers on any other, including their disconnects.

`fly.toml` raises the per-Machine connection ceiling to 500; the default of 25
would shed presence connections long before memory became the limit. Idle
Machines suspend rather than stop, so a resumed one skips the cold boot.
