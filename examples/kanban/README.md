# Multiplayer kanban — on Vercel, with an S3 bucket as the only database

**Live: [reflectdb-kanban.vercel.app](https://reflectdb-kanban.vercel.app/)**

A collaborative board where **every durable byte lives in object storage**. No
Postgres, no SQLite, no volume, no Redis. Deployed as Vercel functions, backed by
a Tigris bucket.

Open two tabs and drag a card. The strip under the header ticks once per batch
that reaches the bucket.

The board is open to anyone with the link, and `?board=<slug>` makes a new one.
**Every board resets to its starting cards every five minutes**, including ones
made with `?board=<slug>` — this is a public demo with no sign-in, so there is
nowhere to put data that is meant to last.

## What this example is actually demonstrating

Running a sync engine on serverless functions breaks two assumptions that a
long-lived server gets for free. Both fixes are the point of the example.

**Any request can land on any instance, so there is no single writer.** The
object-storage adapter normally elects one writer per room with a lease and
keeps authoritative state in its memory. Vercel cannot promise room affinity, so
a second instance would take `NotWriterError` and stop. This board runs
`concurrency: "optimistic"` instead: no lease, instances race on the manifest
compare-and-swap, and the loser re-reads and retries. That rests on the same
guarantee the lease mode does — the CAS is what keeps the data correct, and the
lease was only ever an optimization.

**A function cannot hold a WebSocket, and SSE is one-way.** The client POSTs a
message to one invocation while its event stream is held by another, so every
reply — `hello_ack`, the bootstrap snapshot, op acks — would be enqueued onto a
stream the POST's process does not own, and the client would hang at the
handshake. `serverless: true` on the SSE transport returns those replies in the
POST's own response. The stream is then left doing the one thing it is good at:
pushing *other people's* changes.

```
   browser
     │  POST /api/sync/messages ──▶ invocation A ──▶ writes to the bucket
     │      ◀── replies inline           (CAS; retries if it loses)
     │
     └─ GET /api/sync/events  ───▶ invocation B  (held open)
            ◀── other people's deltas      │
                                  every 250ms:
                                    storage.refresh()      1 manifest GET
                                    → changed? re-run queries and push
```

`refresh()` is load-bearing. Under optimistic concurrency this instance's memory
is *not* authoritative — a teammate's card moved on some other invocation
entirely — so without it the poll would compare against a view that never
changes and stream nothing, forever.

The stream invocation also has to **rebuild the client's subscription**, for the
same reason the POST invocation rebuilds its session: the `sync_declare` went to
a different process. The broadcast engine only pushes to subscribers it can see,
and it pushes a *diff* against that subscriber's cached result — so the stream
replays `hello`, `sync_declare` and `bootstrap` and discards the replies. Without
the subscription it faithfully notices every remote write and has nobody to send
it to; without the bootstrap its cache is empty, so every current row looks new
and every deleted row is invisible.

## The five-minute reset

The demo board is open to the internet, so it fills up. It resets on a five-minute
window, and the reset is **lazy** rather than a cron job: every request checks
whether the current window has been claimed, and the first one to notice does the
work. A `resets/<board>/<window>` key created with `If-None-Match: *` — the same
create-if-absent primitive the manifest seeds itself with — makes exactly one of N
racing invocations the winner.

The claim is taken on the *window*, not on the board's contents: a window that
opens on an already-pristine board is claimed by its first request, which then
finds nothing to reset and writes nothing. Skipping the claim in that case is the
tempting shortcut and is wrong — the window would still look unspent, so the first
visitor edit would be wiped by whatever request arrived next, which on a board with
two tabs open is immediately. Edits are meant to survive until the clock rolls over.

That buys three things a cron does not:

- **It works on any plan.** Vercel's Hobby tier runs cron jobs at most once a day,
  so `*/5 * * * *` is not deployable there at all.
- **An idle board still costs nothing**, which is the same argument the rest of
  this example makes about idle rooms. No visitors, no requests, no resets.
- **A visitor never sees stale cards.** The reset runs *before* their bootstrap
  snapshot is built, not on a schedule that might have last fired four minutes ago.

Resets are written through `handler.applyServerOp`, not `storage.putRow`. The op
log is what other invocations poll, so a bare row write would be invisible to every
tab already open — they would keep rendering cards that no longer exist until they
reconnected.

## Deploy

Any S3-compatible bucket works. The live demo runs on Tigris, provisioned in one
command; R2 is equally good and also has free egress.

```bash
fly storage create               # Tigris bucket + keys, or bring your own
vercel link
vercel env add S3_BUCKET
vercel env add S3_ACCESS_KEY_ID
vercel env add S3_SECRET_ACCESS_KEY
vercel env add S3_PROVIDER       # tigris | r2 | aws | minio | gcs
vercel env add S3_ENDPOINT       # tigris: https://fly.storage.tigris.dev
vercel deploy --prod          # or just push to main
```

**Deploy from the repository root, not this directory.** Two constraints force
it, and both are visible in the root `vercel.json`:

- The example imports reflectdb from `src/`, so the deploy context has to
  include it — deploying this folder alone uploads 17 files and the build fails
  on a missing import.
- `scripts/build-kanban.ts` **bundles** the two API routes into functions
  itself. reflectdb's source imports carry explicit `.ts` extensions, and
  Vercel's Node builder rewrites the entry file to `.js` without rewriting those
  specifiers — the function then boots and dies on `ERR_MODULE_NOT_FOUND`.
  Bundling resolves everything ahead of time.

The Vercel project is linked to this repository with its Root Directory left at
the repository root, so a push to `main` deploys the demo; `vercel deploy` is
only for deploying a dirty tree.

That root `vercel.json` governs *every* project built from this repo whose Root
Directory is the repo itself. The landing site sets its Root Directory to
`landing` and carries its own `landing/vercel.json` — a config inside a Root
Directory wins over the repository-root one. Deleting `landing/vercel.json`
would point the landing build at `scripts/build-kanban.ts`, which is not on
disk from there, and every landing deploy would fail.

The build writes the [Build Output API](https://vercel.com/docs/build-output-api)
(`.vercel/output`) rather than dropping bundles in `api/`, because Vercel
enumerates `api/` from the *source tree*, before the build command runs.
Bundles written there during the build are invisible to it: the deploy goes
green and every route 404s. Emitting `.vercel/output/functions/**.func`
ourselves also carries the settings a `functions` block in `vercel.json` cannot
— that block is validated against the same pre-build source tree — including
the SSE route's 300-second `maxDuration` and `supportsResponseStreaming`,
without which the platform holds every event until the stream ends.

Each function's `index.mjs` wraps the route in a Node `(req, res)` adapter: the
routes are written against web `Request`/`Response`, which is what Vercel's own
`api/` builder hands them, and the raw launcher is not. The adapter flushes the
response headers before the first event and destroys the body stream when the
client disconnects — that is what the SSE route's `cancel` hook listens for.

A board that cannot boot clears itself. `openBoard` catches
`IncompleteStateError` — the manifest naming an object the bucket no longer has
— wipes the room's prefix and starts it over. That is right *here*, where a
board reseeds every five minutes anyway, and wrong in an application holding
real data: there the refusal is telling you the store lost an acknowledged
write, and clearing the room destroys what survived along with the evidence.

New Vercel projects also enable Deployment Protection, which 401s the API. Turn
it off for a public demo.

`bun run scripts/wipe-kanban.ts` clears every board in the bucket outright — the
blunt version of the five-minute reset, including the claim markers it leaves
behind.

| Variable | Required | Notes |
|---|---|---|
| `S3_BUCKET` | yes | |
| `S3_ACCESS_KEY_ID` | yes | |
| `S3_SECRET_ACCESS_KEY` | yes | |
| `S3_PROVIDER` | no | `r2` (default), `aws`, `tigris`, `minio`, `gcs` |
| `R2_ACCOUNT_ID` | for R2 | endpoint is `https://<id>.r2.cloudflarestorage.com` |
| `S3_ENDPOINT` | MinIO, Fly-issued Tigris | MinIO has no default; a Fly-provisioned Tigris bucket uses `fly.storage.tigris.dev`, not the preset's `t3.storage.dev` |
| `S3_REGION` | no | defaults per provider |

**MinIO needs one extra step.** It rejects the `If-None-Match: *` wildcard, so
the room has to be seeded once with `storage.init()` as a *deploy* step — not
from N racing servers. Every other provider seeds itself on first write.

## Run it locally

```bash
bun install
KANBAN_LOCAL_DIR=.data vercel dev    # functions + static, on one port
```

`KANBAN_LOCAL_DIR` swaps the bucket for a directory, so the board runs with no
credentials at all — the filesystem driver has the same CAS semantics, and the
whole conformance suite runs against both. Drop it to point local development at
a real bucket instead. It is development-only: a filesystem cannot make
compare-then-rename atomic across processes, which is exactly the guarantee the
manifest depends on.

`vite` alone serves the UI but not `/api`, so the board will not connect.

Everything is namespaced under the `kanban/` prefix, and `?board=<slug>` picks a
room, so one bucket holds as many boards as you like.

## Cost

An idle board costs nothing: no lease to renew, and the flush loop blocks when
there is nothing to write. An open tab polls the manifest 4×/second — roughly
14k GETs/hour/tab, which on R2 is fractions of a cent. Raise `POLL_MS` in
`api/sync/events.ts` to trade latency for requests.

## What it does not do

- **No presence or cursors.** They need a shared ephemeral bus (`createRedisEphemeral`);
  the in-process default cannot cross invocations, so it would show each visitor
  only themselves.
- **No auth.** `allowAnonymous: true` — anyone with the link edits the board.
  Register an `auth()` callback to gate it.
- **Positions are floats.** Dropping ~50 cards into the same slot exhausts float
  precision and ties sort by id. Stable and consistent, just no longer the order
  you dropped them in. A production board would rebalance the column.

## Files

| File | What it holds |
|---|---|
| `lib/board.ts` | storage + handler for one invocation; the two config flags above |
| `lib/reset.ts` | the five-minute window, the claim key, and the seed cards |
| `api/sync/messages.ts` | POST; returns its own replies via `collectReplies` |
| `api/sync/events.ts` | SSE stream; subscription restore, then the `refresh()` → `pollRemoteChanges()` loop |
| `schema.ts` | card shape, column list, fractional positioning |
| `src/main.ts` | client; `SyncClient` wired to the SSE transport directly |

Design and rationale for the storage layer: [`docs/object-storage.md`](../../docs/object-storage.md).
