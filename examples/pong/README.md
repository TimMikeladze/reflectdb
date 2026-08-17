# infinite pong

Circular pong with no player cap. The rim is divided into one arc per connected
player; join and it re-partitions, leave and it re-partitions again. Balls are
added as the crowd grows.

```bash
cd examples/pong
bun install
bun dev
# http://localhost:3004 — open a second tab to add a second player
```

Identity is per tab (sessionStorage), so extra tabs are extra players. Add
`?game=anything` for a separate arena.

## What it demonstrates

| Pattern | Where |
|---------|-------|
| One schema shared by both sides — including the arena geometry | [`schema.ts`](./schema.ts) |
| Server-authoritative loop with `server.interval` + `server.tryLock` | `tick` in [`server.tsx`](./server.tsx) |
| Server-origin writes through `server.applyServerOp` (score updates) | `tick` in [`server.tsx`](./server.tsx) |
| `groupBy` collapsing N subscribers into one query execution | `players` / `balls` in [`server.tsx`](./server.tsx) |
| `serverSet` deriving a column from subscription params (`gameId`) | `players` in [`server.tsx`](./server.tsx) |
| `readonly` columns the client can never move (`score`, `misses`) | [`schema.ts`](./schema.ts) |
| Row ownership enforced with `MutationError` | `players.mutate` in [`server.tsx`](./server.tsx) |
| Rooms scoping every arena, fail-closed | `server.room` in [`server.tsx`](./server.tsx) |
| A `view()` for the leaderboard — read-only, recomputed from `players` | `standings` in [`server.tsx`](./server.tsx) |
| Typed `presence()` for emoji taunts (never persisted) | `taunts` in [`app.tsx`](./app.tsx) |
| Per-table rate limits, and a separate bucket for ephemeral traffic | `server.rateLimit` in [`server.tsx`](./server.tsx) |
| `broadcast: "eager-durable"` for a chatty single-writer table | `players` in [`server.tsx`](./server.tsx) |
| Optimistic local paddle + dead reckoning between server frames | `paint` in [`app.tsx`](./app.tsx) |
| Interpolating remote state so peers move instead of teleporting | [`interpolate.ts`](./interpolate.ts) |

## How it works

**Paddles go up, balls come down.** A paddle is an ordinary row in `players`:
the local one is written at pointer rate and applied optimistically, so your own
paddle never waits for the server. Everyone else's arrives as a delta. Ball state
is owned entirely by the physics loop and is never writable by a client — its
`mutate` throws `readonly_query`.

**The arena is derived, not stored.** Nothing records "player 3 owns the arc from
here to there". Both sides run `buildSectors()` over the current player list, so
the seating chart is a pure function of who is connected. Adding a player
re-partitions the rim on every screen at once, with no migration step.

**The server tick is the only clock.** `server.interval(33ms)` advances every
ball, checks it against the paddle arc of whichever sector it crossed, and calls
`notifyChange("balls", roomKey)`. `tryLock` means a slow tick is skipped rather
than queued. Score changes go through `applyServerOp`, which stamps an HLC, runs
your write, then commits reflectdb's mirror and broadcasts — so the two stores
stay in step.

**One query execution per arena.** Subscribers are grouped by everything that can
change a result, which by default includes their auth — so N players would mean N
executions of the balls query, 30 times a second. `groupBy: ({ params }) =>
params.gameId` collapses them to one, since every player in an arena is entitled
to identical rows. That single line is what makes "infinite players" a claim
rather than a joke.

**40 Hz on the wire, 60 fps on screen.** Ball rows carry position *and* velocity,
so the renderer extrapolates from the last frame it received (capped at 250 ms, in
case the tab was backgrounded). Deltas only carry the columns that changed.

**Nothing waits for the network to move.** Four separate things keep it feeling
immediate, and they are worth separating because they solve different problems:

| Problem | Fix |
|---------|-----|
| Your own paddle lagging your pointer | It renders from local input every frame — the sync write is only for other people. |
| Paddle writes paying for a conflict pass | `broadcast: "eager-durable"`. Paddles are single-writer, so there is no conflict to resolve; the delta goes out the moment `mutate` returns instead of after a re-query and diff. |
| Other players teleporting between updates | Remote paddles are eased toward their last known angle every frame ([`interpolate.ts`](./interpolate.ts)) — ~100 ms to converge, which reads as movement rather than lag. Yours is never eased. |
| The ball stepping at tick rate | Dead reckoning from the velocity in each ball row. |

One trap worth naming: rate limits have to sit *above* the client's send rate. A
paddle op rejected for `rate_limited` reverts the optimistic write, which snaps
the paddle backwards — the exact jitter you were trying to remove. The client
caps itself at ~60 ops/s and skips sub-visible moves; the server budget is 120.

**A ball is never stuck.** Three separate rules, because "the physics is correct"
is not a guarantee:

1. `deflect` rebuilds the outgoing direction in the rim's frame and floors the
   inward component at `MIN_INWARD`. Spin can curve a shot but can never rotate it
   back out through the wall — a ball that leaves a collision still heading
   outward re-collides forever while the paddle sits under it.
2. Anything non-finite, motionless, or outside a live sector is put back in play
   on the next tick.
3. A watchdog resets any ball that loiters within `RIM_BAND` of the rim for
   `STUCK_TICKS` (~2 s), whatever the physics believes.

The physics lives in [`physics.ts`](./physics.ts) rather than the server so it can
be tested headless — [`physics.test.ts`](./physics.test.ts) asserts the invariant
over every approach angle and hit offset, and runs an adversarial 6,000-tick game
where the paddle teleports under the ball every tick. `bun test` from the repo root
picks it up.

**Presence is not state.** Taunts ride the ephemeral channel: room-scoped,
TTL'd, never written to the op log, and metered on their own rate-limit bucket.

## Deliberate simplifications

- Everything lives in memory. Restart the server and the arena is empty — for a
  live game that is the honest default. Point `db` at anything else and the
  `query`/`mutate` callbacks are the only code that changes.
- Players are reaped after 15 s without a write. The client keeps its row warm
  with a keepalive; `serverSet: { lastSeen }` makes every paddle move a heartbeat.
- Scores are provisional in the sense that a client can see its own optimistic
  paddle before the server agrees. Nothing else about the game is client-decided:
  the server clamps the paddle angle it was told, because a client is free to lie.
