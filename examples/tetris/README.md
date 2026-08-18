# infinite tetris

One perpetual multiplayer Tetris game with no player cap. Every visitor gets a
standard 10×20 well and a server-assigned random name. Players can appear or
leave at any time; there are no rooms, rounds, or lobby resets. Top out and your
score returns to zero, your well clears, and the next run begins immediately.

```bash
cd examples/tetris
bun install
bun dev
# http://localhost:3004 — open another tab to add another player
```

Identity is per tab (`sessionStorage`), so each extra tab is a new player in the
same ongoing game.

## Controls

| Input               | Action                   |
| ------------------- | ------------------------ |
| Left / right arrows | Move                     |
| Down arrow          | Soft drop                |
| Up arrow or X       | Rotate clockwise         |
| Z                   | Rotate counter-clockwise |
| Space               | Hard drop                |

## What it demonstrates

| Pattern                                                                       | Where                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------- |
| Shared typed protocol and tetromino geometry                                  | [`schema.ts`](./schema.ts)                        |
| Server-authoritative rules separated for headless tests                       | [`game.ts`](./game.ts)                            |
| Bun SQLite game state and durable reflectdb sync storage                      | [`database.ts`](./database.ts)                    |
| One perpetual unparameterized query instead of per-room state                 | `players` in [`server.tsx`](./server.tsx)         |
| `groupBy` collapsing all subscribers into one query execution                 | `players` in [`server.tsx`](./server.tsx)         |
| Client-writable input fields with authoritative game fields marked `readonly` | [`schema.ts`](./schema.ts)                        |
| `serverSet` refreshing `lastSeen` for join/leave detection                    | `players` in [`server.tsx`](./server.tsx)         |
| Ownership checks rejecting controls for another player's well                 | `players.mutate` in [`server.tsx`](./server.tsx)  |
| Server gravity with `server.interval` and `server.tryLock`                    | [`server.tsx`](./server.tsx)                      |
| A read-only `view()` leaderboard                                              | `standings` in [`server.tsx`](./server.tsx)       |
| Responsive live boards rendered from synchronized rows                        | [`app.tsx`](./app.tsx)                            |
| Immediate local input prediction with sequence-based server reconciliation    | [`app.tsx`](./app.tsx) and [`game.ts`](./game.ts) |

## How it works

**Inputs react locally, then reconcile.** Every keyboard or touch action is
applied to the local board immediately, in the same event that captured it, and
is also sent with an increasing `inputSeq`. The client replays unacknowledged
inputs over each server snapshot using `processedSeq`; the server remains
authoritative without putting a network round trip between a keypress and a
visible move. A server-generated piece queue keeps even consecutive hard drops
deterministic during prediction. Held left/right uses an 85 ms delayed-auto-shift
and repeats every 25 ms, independently of the operating system's key-repeat
settings.

**The server is the clock.** A 50 ms interval advances gravity for every active
player. `tryLock` skips a tick if the previous broadcast is still running, so
load causes a slightly late frame rather than an ever-growing queue. A capped
elapsed time also prevents a stalled process from producing a gravity storm.

**Bun SQLite is the database.** [`database.ts`](./database.ts) stores complete
authoritative player and runtime state in `tetris_players`. The same `tetris.db`
file holds reflectdb's durable rows, operation log, processed operation IDs, and
server clock. Writes from inputs and gravity ticks use SQLite transactions, with
WAL mode enabled. Set `TETRIS_DB_PATH` to override the default file location.

**There is exactly one game.** The schema has no `gameId` parameter and the
server creates no rooms. Every subscriber receives the same player rows and
standings. `groupBy: () => "global-game"` means reflectdb executes that shared
query once per change, rather than once per authenticated subscriber.

**Joining is just inserting your row.** The server ignores any claimed name and
assigns an unused adjective-noun-number name. The client removes its row when the
page closes, while a heartbeat and 15-second server timeout cover abrupt network
loss, so a departed player does not leave a dead well behind. Reopening or
opening another tab joins the same ongoing game without affecting anyone else's
run.

**Death is local and non-terminal.** When a queued tetromino cannot spawn, the
server counts a death, clears that player's board, resets score and lines to
zero, draws a fresh piece pair, and keeps gravity running. Nobody waits for a
round restart, and the shared game never ends.

Scoring is deliberately compact: soft drops award one point per cell, hard
drops two, and one through four cleared lines award 100/300/500/800 points.
Each player gains a level every five lines in their own run. Their gravity speed
then follows an accelerating curve from 800 ms per row toward a 75 ms cap,
independently of every other player. A top-out resets their lines, level, and
speed along with their score.

## Verification

```bash
bun test examples/tetris
bunx tsc -p examples/tetris/tsconfig.json --noEmit
```

[`game.test.ts`](./game.test.ts) covers rotations, walls and settled-cell
collisions, hard drops, line clears, server gravity, random-name uniqueness,
join/leave reaping, and the score-reset-and-continue top-out invariant.

[`database.test.ts`](./database.test.ts) additionally verifies full runtime-state
persistence across a database restart, transaction rollback, indexed stale-player
cleanup, and reflectdb metadata sharing the same SQLite file.

## Deploy the smallest Fly.io example

The included [`fly.toml`](./fly.toml) runs one `shared-cpu-1x` Machine with 256 MB
RAM. It scales to zero when idle and starts on the next request. There is no Fly
Volume: `persist_rootfs = "restart"` retains SQLite across an ordinary Machine
stop/start, but deployments and Machine replacement can reset the example data.

From the repository root:

```bash
# Only needed once. Change the name in fly.toml if it is already taken.
fly apps create reflectdb-tetris

# --ha=false is important: one ephemeral SQLite file means one Machine.
fly deploy --ha=false -c examples/tetris/fly.toml .
fly apps open -a reflectdb-tetris
```

The Docker image prebuilds the browser bundle, then ships only Bun, the reflectdb
source used by the example, and the Tetris application. No database service,
volume, release Machine, or always-running Machine is required.

### Automatic deploys

[`.github/workflows/deploy-demos.yml`](../../.github/workflows/deploy-demos.yml)
redeploys this app on every push to `main` whose CI run passed, and can also be
run manually from the Actions tab. It deploys every `examples/*/fly.toml` it
finds, so a new demo only has to ship a `fly.toml` and a `Dockerfile` — the
workflow needs no edit.

Each demo authenticates with its own app-scoped deploy token, stored as a
repository secret named after the app (`reflectdb-tetris` →
`FLY_API_TOKEN_REFLECTDB_TETRIS`). A single `FLY_API_TOKEN` covering every demo
is used as a fallback. To rotate or add one:

```bash
fly tokens create deploy -a reflectdb-tetris | gh secret set FLY_API_TOKEN_REFLECTDB_TETRIS
fly tokens list -a reflectdb-tetris   # `fly tokens revoke <id>` retires the old one
```
