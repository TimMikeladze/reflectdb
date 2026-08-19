# collaborative whiteboard + pictionary

A shared canvas anyone can draw on, with an optional Pictionary mode layered on
top of the same rows. Rooms are created from a lobby, strokes and chat replicate
to everyone in the room, peer cursors move in real time, and the round engine —
word choice, timer, scoring, drawer rotation — runs entirely on the server.

Nothing sticks around: a room and everything drawn or typed in it is deleted 30
minutes after the room is created.

```bash
cd examples/whiteboard
bun install
bun dev
# http://localhost:3003 — open another tab to draw together
```

There are no accounts. **Start drawing** mints an anonymous
[better-auth](https://better-auth.com) user with a generated guest name, and
that session's token is what authenticates the sync socket. **New guest** in the
top bar drops the session; the next one arrives under a new name.

## Two modes, one canvas

**Freeform draw.** Everyone can draw at once. A stroke is one row, so two people
drawing simultaneously never conflict — they insert different rows.

**Pictionary.** Players take turns drawing while the rest guess in chat. The
server picks three candidate words, gives the drawer 15 seconds to choose one
(and auto-picks if they don't), runs the round clock, awards points on time
remaining, rotates the drawer, and ends the game after the configured number of
rounds. Guessers see a masked word; only the drawer's connection ever receives
the answer.

## What it demonstrates

| Pattern                                                                         | Where                                                     |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Drizzle-typed schema over Bun SQLite, sharing one file with the op log          | [`schema.ts`](./schema.ts)                                |
| Guest-only authentication with better-auth's anonymous plugin                   | [`auth.ts`](./auth.ts)                                    |
| The session token authenticating the WebSocket, not just the HTTP API           | `server.auth` in [`server.tsx`](./server.tsx)             |
| `params`-scoped queries — strokes, players, and messages per room               | [`server.tsx`](./server.tsx)                              |
| Per-user query results: only the drawer's connection receives the secret word   | `roundWord` in [`server.tsx`](./server.tsx)               |
| A server-side round engine with a per-room mutex and `notifyChange`             | `tick`, `withLock` in [`server.tsx`](./server.tsx)        |
| Server-side guess detection, rewriting the message so the answer never fans out | `mutateMessageWithGuesses` in [`server.tsx`](./server.tsx) |
| `readonly` fields keeping engine state out of client hands                      | [`schema.ts`](./schema.ts)                                |
| Ephemeral peer cursors, scoped per room with `key: cursor:${gameId}`            | `useCursors` in [`app.tsx`](./app.tsx)                    |
| Per-table rate limits — loose for strokes, tight for chat                       | `server.rateLimit` in [`server.tsx`](./server.tsx)        |
| Out-of-band deletes (a TTL sweep) reaching clients through `notifyChange`       | `sweepExpiredRooms` in [`schema.ts`](./schema.ts)         |

## How it works

**A stroke is a row, not a stream.** Each drag produces one `strokes` row holding
its points, color and width. Nothing merges partial strokes, so two people
drawing over each other both keep their lines, and a late joiner rebuilds the
whole canvas by replaying rows rather than by asking for a snapshot image.

**The secret word never leaves the server for the wrong client.** `roundWord` is
a query, not a column: it returns a row only when the requesting connection is
the current drawer. Everyone else receives an empty result for the same
subscription, so the mask in the HUD is all a guesser's tab has ever been told.
Guesses are checked in `mutateMessageWithGuesses` before the message is stored — a correct guess is
replaced with a "guessed in 12s (+95)" line, so the answer is never broadcast
even to the person who typed it.

**One writer per room.** Scores, correct-guesser lists and round state are
JSON columns read-modify-written by guesses, joins and timer ticks alike. Every
one of those paths goes through a per-room promise chain, so two people guessing
in the same instant can't trample each other's score update. The timer uses the
non-blocking variant and simply skips a tick while a room is busy.

**The clock is server-side.** A 500 ms interval ends rounds that ran out of
time, starts the next pick after the scoreboard pause, and auto-picks for a
drawer who never chose. Clients render a countdown from `roundEndsAt` but never
decide that a round is over.

**Rooms expire after 30 minutes.** The deployment is a public sandbox on one
small Machine, so `ROOM_TTL_MS` in [`expiry.ts`](./expiry.ts) caps how long
anything lives. Every 30 seconds the server deletes rooms past that age along
with their strokes, chat, player rows and round secrets, then sweeps up content
whose room is already gone — which is what makes an interrupted delete
self-healing. The deletes go through drizzle rather than the sync pipeline, so a
5,000-stroke room costs one `DELETE` instead of 5,000 op-log rows; the
`notifyChange` that follows makes every subscriber re-run its query, and the
diff against the previous result set is what turns the vanished rows into
deletes on the client. A tab sitting in a room that expires under it lands back
in the lobby with a note; the header and the lobby cards count the room down
from the same constant the sweeper uses.

**Cursors are ephemeral.** Peer pointers move through `useEphemeral`, keyed per
room, so they fan out to the room without touching the database or the op log.
They vanish when a tab closes instead of leaving rows to reap.

**Two SQLite files.** `whiteboard.db` holds application rows plus reflectdb's op
log, processed op ids and server clock. `auth.db` holds better-auth's users and
sessions — all of them anonymous — deliberately outside the synchronized
database. Both paths, the port
and the public origin come from the environment — see [`config.ts`](./config.ts).

## Verification

```bash
bunx tsc -p examples/whiteboard/tsconfig.json --noEmit
bun test ./examples/whiteboard/expiry.test.ts   # room expiry sweep
```

## Deploy to Fly.io

The included [`fly.toml`](./fly.toml) runs one `shared-cpu-1x` Machine with
512 MB RAM. It scales to zero when idle and starts again on the next request.
There is no Fly Volume: `persist_rootfs = "restart"` keeps both SQLite files
across an ordinary Machine stop/start, but a deployment or a Machine replacement
resets the demo — rooms, drawings and guest sessions included. The 30-minute
sweep means the database never grows far anyway; a Machine that slept through a
room's whole lifetime sweeps once on wake, before it serves a request.

From the repository root:

```bash
# Only needed once. Change the name in fly.toml if it is already taken.
fly apps create reflectdb-whiteboard

# --ha=false is important: two SQLite files on one rootfs mean one Machine.
fly deploy --ha=false -c examples/whiteboard/fly.toml .
fly apps open -a reflectdb-whiteboard
```

`WHITEBOARD_BASE_URL` in `fly.toml` has to match the hostname browsers actually
use — better-auth signs cookies for that origin and rejects requests from any
other. Change it alongside the app name if you deploy under a different one.

better-auth also refuses to start in production on its built-in default secret.
Set your own with `fly secrets set BETTER_AUTH_SECRET=$(openssl rand -hex 32)`;
without it the demo generates a secret on first boot and stores it next to the
guests it signs for, so sessions survive a restart but not a redeploy.

### Automatic deploys

[`.github/workflows/deploy-demos.yml`](../../.github/workflows/deploy-demos.yml)
redeploys this app on every push to `main` whose CI run passed, and can also be
run manually from the Actions tab. It deploys every `examples/*/fly.toml` it
finds, so a new demo only has to ship a `fly.toml` and a `Dockerfile`.

Each demo authenticates with its own app-scoped deploy token, stored as a
repository secret named after the app (`reflectdb-whiteboard` →
`FLY_API_TOKEN_REFLECTDB_WHITEBOARD`). A single `FLY_API_TOKEN` covering every
demo is used as a fallback. To rotate or add one:

```bash
fly tokens create deploy -a reflectdb-whiteboard | gh secret set FLY_API_TOKEN_REFLECTDB_WHITEBOARD
fly tokens list -a reflectdb-whiteboard   # `fly tokens revoke <id>` retires the old one
```
