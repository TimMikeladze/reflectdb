# Object-storage backend (design)

Status: **phase 1 shipped**; phases 2-4 are design. reflectdb's server runs with
object storage as the only durable store — no Postgres, no SQLite, no volume.

Works against any S3-compatible store: AWS S3, Cloudflare R2, Tigris, MinIO, GCS.
Shipped as `reflectdb/server/storage/object`; [`examples/kanban`](../examples/kanban/)
is a board running on it, on Vercel functions, with no database anywhere.

---

## Table of Contents

- [Why this is possible](#why-this-is-possible)
- [Architecture](#architecture)
- [Layout](#layout)
- [Writer election and fencing](#writer-election-and-fencing)
- [Concurrency modes](#concurrency-modes)
- [Group commit](#group-commit)
- [Durability model](#durability-model)
- [Backpressure and health](#backpressure-and-health)
- [Memory budget](#memory-budget)
- [Shutdown](#shutdown)
- [Compaction and GC](#compaction-and-gc)
- [Provider compatibility](#provider-compatibility)
- [The driver interface](#the-driver-interface)
- [Configuration](#configuration)
- [Known limits](#known-limits)
- [Deferred work](#deferred-work)
- [Phases](#phases)

---

## Why this is possible

Object stores gained compare-and-swap. AWS S3 shipped `If-None-Match: *`
(create-if-absent) in August 2024 and `If-Match: <etag>` (conditional overwrite)
in November 2024. R2, Tigris, MinIO and GCS have equivalents. CAS on a single
small object is a linearization point, and a linearization point is all you need
to build a log-structured database.

Three properties already in reflectdb make it a good fit:

1. **Ops are idempotent.** `reserveOp` dedupe plus stable op ids means replay is
   safe, so a crash that loses unflushed ops is recoverable by client resend —
   provided the client still holds the op. See [durability](#durability-model).
2. **HLCs order the log.** Storage never has to assign a sequence number, so
   there is no need for a monotonic counter service.
3. **Rooms shard naturally.** `src/server/rooms.ts` already scopes state. One
   writer per room is not a limitation, it is the routing key.

That third property is the real payoff. Today HA needs shared Postgres because
any instance may serve any room. Route room to instance and the writer *is* the
server: the shared-storage polling path disappears entirely.

## Architecture

**The object store is durability, never the read path.**

```
                   ┌─────────────────────────────────┐
   WS clients ───► │  writer instance (one per room) │
                   │                                 │
                   │  in-memory authoritative state  │ ◄── all reads, sync-fast
                   │  rows + colClocks + op ring     │
                   │  reserveOp set + meta           │
                   │             │                   │
                   │             ▼                   │
                   │  WAL buffer ──► group commit    │
                   └─────────────┬───────────────────┘
                                 │  1 PUT per batch
                                 ▼
                   ┌─────────────────────────────────┐
                   │  object store                   │
                   │  _lease  _manifest  wal/  snap/ │
                   └─────────────────────────────────┘
```

Reads (`getRow`, `getRows`, `getOpsSince`, `reserveOp`) hit memory and never
touch the network — measurably faster than the SQLite adapter. Writes mutate
memory and append to a buffer; the buffer flushes to the store as one object per
batch.

Boot reads the manifest, loads the newest snapshot, replays every segment the
manifest still lists, and serves from memory thereafter.

Note that replay is driven by `walSegs` membership, **not** by comparing each
segment's `maxHlc` against `snapshotHlc`. Compaction empties `walSegs` in the
same CAS that publishes the snapshot, so membership already means "committed
after the snapshot" — while HLC is assigned by the caller and is not append
order, so a `putRow` carrying a low HLC after a compaction would be silently
dropped by an HLC comparison.

## Layout

```
<prefix>/rooms/<roomId>/
  _lease                       CAS'd. writer election + fencing epoch
  _manifest                    CAS'd. {epoch, commitSeq, lastWriter, snapshotKey,
                               snapshotHlc, walSegs[], oplogHead, meta, pendingGc[]}
  wal/<token>-<seq>.jsonl      immutable op batches. name is unique, no CAS needed
  snap/<token>-<seq>.json      materialized rows (phase 1)
  snap/<table>-<hlc>.parquet   materialized rows (phase 3, DuckDB)
```

`<token>` is the fencing epoch under `"single-writer"` and the instance's
`writerId` under `"optimistic"`. The distinction is load-bearing, not cosmetic:
without a lease every instance reads the same epoch, so an epoch-named key is
the same key on every instance. Two of them then write one object, and the
commit that supersedes it lists the key it is still pointing at as garbage —
an hour later GC deletes the live snapshot and the room never boots again.

Only `_lease` and `_manifest` are ever overwritten, and both only via CAS.
Everything else is write-once, which is what makes concurrent readers safe.

## Writer election and fencing

```ts
// acquire
const cur = await driver.get("_lease");            // { owner, epoch, expiresAt }
if (cur && cur.body.expiresAt > now) return NOT_LEADER;
await driver.put("_lease", { owner: me, epoch: cur.body.epoch + 1, expiresAt: now + ttl },
                 { ifMatch: cur.etag });           // loser gets 412
```

Every WAL segment name and every manifest write carries `epoch`.

**The manifest CAS is the real guard, not lease expiry.** A zombie writer that
lost its lease still holds a stale manifest etag, so its manifest CAS fails with
412. It can only write orphan WAL segments, which readers skip by epoch. This
sidesteps the classic "paused process still holds a valid lease" hole — the lease
is an optimization to avoid wasted work, not the safety mechanism.

The writer must **self-fence**: a failed renewal stops write acceptance
immediately.

### Lease TTL is long on purpose

TTL only bounds *unclean* failover, because [`close()`](#shutdown) releases the
lease explicitly. Long TTL is what makes idle rooms cheap:

| TTL / renew | Unclean failover | PUTs/day/room | Cost/month/room |
|---|---|---|---|
| 30s / 10s | 30s | 8,640 | ~$1.30 |
| 300s / 120s | 5min | 720 | ~$0.11 |

Default is **300s / 120s**, with `lease.mode: "on-write"` so a room holding
connected clients but taking no writes spends nothing at all.

## Concurrency modes

The lease above assumes the deployment can route a room to one instance. Some
cannot — Vercel functions, Lambda, anything where any request lands on any
instance — so the adapter takes a `concurrency` mode.

| Mode | Lease | In-memory state | Route a room to one instance |
|---|---|---|---|
| `"single-writer"` (default) | elected, renewed, fenced | authoritative | required |
| `"optimistic"` | none | may be stale | not required |

`"optimistic"` rests on exactly the same guarantee `"single-writer"` does:
**the manifest CAS is what keeps the data correct, and the lease was only ever
an optimization** to stop two servers doing redundant work. Concurrent writers
race on the CAS, the loser re-reads and retries, and nobody is fenced.

What it costs is that in-memory state is no longer authoritative, because another
instance may have committed since this one last looked. Hence:

```ts
await storage.refresh();   // one GET; true when the room actually moved
```

`refresh()` re-reads the manifest and applies any segments — or another
instance's snapshot — that landed since. It does nothing further when `commitSeq`
has not changed, which is what makes a serverless poll loop affordable: the
steady state is a single small read, and queries re-run only when it returns
true. Under `"single-writer"` it resolves `false` without a request, because this
instance *is* the writer and there is nothing to catch up on.

### `commitSeq` closes an ABA hole

The manifest carries a counter that increments on every commit, and it exists
solely to make the manifest bytes differ on every write.

S3 derives an etag from object content, so writing identical bytes leaves the
etag unchanged. Without the counter a writer could read etag E, have another
writer commit a manifest that happens to serialize identically, and still win its
`ifMatch: E` — a lost update no 412 ever reports. In practice `oplogHead` and
`walSegs` almost always differ, but "almost always" is not a property to rest a
linearization point on.

`lastWriter` rides along for a related reason. Together with `commitSeq` it
identifies a commit uniquely, which is what lets a writer that took a 412 tell
"my own write, acknowledged late" from "someone else got there first". `epoch`
cannot do that job under `"optimistic"`: with no lease every instance shares the
manifest's epoch, and two of them will attempt the same `commitSeq` — so an
epoch-based check would adopt a rival's commit as its own and silently drop the
segment it just wrote.

### What the platform still owns

`"optimistic"` removes the routing requirement, not the two things a serverless
runtime does differently. Both are worked through in
[`examples/kanban`](../examples/kanban/):

- **The session is rebuilt per invocation.** `hello` and `sync_declare` went to a
  different process, so an instance holding the event stream has no subscriber to
  push to until it replays them — and must `bootstrap` too, because the broadcast
  engine emits a diff against its result cache, and an empty cache makes every
  existing row look new.
- **A reply cannot be streamed by a process that does not own the stream.** The
  SSE transport's `serverless: true` returns each POST's replies in that POST's
  own response; the stream is left pushing other clients' changes.

## Group commit

No `flushMs` knob. The flush loop is **self-clocking**, the same trick Postgres
group commit and Kafka's linger use:

```ts
while (running) {
  await buffer.waitNonEmpty();            // idle blocks here: no timer, no PUT
  if (minLingerMs) await delay(minLingerMs);  // coalesce same-tick ops
  const batch = buffer.drain(maxBytes);
  await driver.put(`wal/${epoch}-${seq++}.jsonl`, encode(batch));
  await casManifest({ walSegs: [...prev, seg], oplogHead: batch.maxHlc });
  emitDurable(batch.maxHlc);
}
```

Exactly one flush is in flight at a time. That single constraint makes it adapt
with no configuration:

- **Low write rate** — buffer holds one op, flush fires at once. Latency is one
  store round trip. Optimal.
- **High write rate** — ops accumulate *during* the in-flight flush, so the next
  batch is naturally as large as the round trip allows. Throughput is
  `maxBytes / rtt`. Optimal.
- **Idle** — the loop blocks. Zero PUTs, zero timers.

Batch size auto-tracks store latency, so a slow provider batches harder and a
fast one (S3 Express, Tigris colocated with Fly) batches less. Exposing a
`flushMs` would invite someone to set 10ms and quadruple their bill for no
latency gain, so it is deliberately not a knob.

`minLingerMs` defaults to 5ms purely to coalesce ops arriving in the same
event-loop tick. Pure win, no latency cost that matters.

## Durability model

### The failure this avoids

Naively acking a write as soon as it hits memory is unsafe:

```
client writes op  →  server applies to memory  →  server acks
client retires op from its pending queue
server crashes before flush
client reconnects  →  resume ships server snapshot  →  the row reverts
```

The client's optimistic write silently disappears. Op idempotency does not save
you, because there is nothing left to replay.

### Resolution

Two modes, and **`"durable"` is the default**:

| Mode | Ack when | Loss window | Correct today |
|---|---|---|---|
| `"durable"` (default) | after manifest CAS | none | yes |
| `"buffered"` | after memory apply | one flush interval | **no** — see below |

`"durable"` costs one store round trip per write batch (~50-150ms on S3, ~10ms on
S3 Express or a colocated Tigris bucket). Correct with **zero protocol change**,
which is why it is the default. Shipping a fast-but-lossy default would be
trading correctness for a benchmark.

`"buffered"` is only safe once the client retires pending ops on a **durable
watermark** rather than on the apply ack:

- `applied` ack — immediate, confirms ordering and conflict outcome, unblocks UI
- `durableHlc` — broadcast after manifest CAS; client retires ops `<= durableHlc`

That is a small protocol change (HLC watermarks are already everywhere in the
codebase) but it is a protocol change, so it lands in phase 2. The adapter
already emits `onDurable(hlc)` today so phase 2 is purely additive.

Until then `"buffered"` is opt-in and documented as lossy.

## Replay protection must be durable too

`reserveOp` is atomic for free — one writer per room, no `await` inside — but
atomicity is not the whole requirement. It also has to survive a restart.

`src/server/op-processor.ts` uses the reservation result to gate the entire
pipeline for an op, **including the query's `mutate` callback**. That callback is
arbitrary user code: incrementing a counter, charging something, sending mail. So
the tempting argument — "a duplicate is harmless, conflict resolution discards it
because its HLC is not newer" — covers only the row write, never the side effect.

Losing the reservation window on every restart would re-run those callbacks for
any client that reconnects and resends, which on a platform that replaces
machines constantly is the common case, not a rare one.

Reservations are therefore written to the WAL as their own record kind:

```ts
{ k: "reserve", opIds: [...], at: <ms> }
```

Appended but **not awaited**. `reserveOp` runs before the op it guards, and that
op's own `applyOp` awaits the very batch the record lands in — so under
`durability: "durable"` the reservation is durable by the time the write it
protects is acknowledged, at zero extra round trips.

Two details that matter:

- A `reserve` record carries no HLC, so it must not advance `oplogHead`. Doing so
  would tell a resuming client the room changed when nothing did.
- Replay restores the record's **original** timestamp, not `now()`. Re-stamping
  on every boot would keep a long-dead op id alive forever in a room that
  restarts often.

## Backpressure and health

An undefined backpressure policy means "OOM during a store outage". Explicit:

```
buffered bytes > batch.maxBufferBytes  →
  "reject"  (default) writes throw ObjectStorageBackpressureError; the client
            retries. Backpressure propagates to the source, which is correct.
  "degrade" keep accepting, stop promising durability, flip health to "degraded"
```

Related: during a store outage under `"durable"`, every client's pending queue
grows without bound. The adapter surfaces health so the app can show
"reconnecting / not saved" rather than lying with a happy UI:

```ts
storage.health            // "healthy" | "degraded" | "unavailable"
storage.onHealthChange(cb)
```

The difference between "degraded" and "corrupted" is designed here, not
discovered in an incident.

## Memory budget

State is authoritative in memory, so the ceiling is a cliff, not a slope. The
budget is **global across rooms**, because a per-room cap lets one whale room
starve five hundred small ones.

```
memory.maxTotalBytes   global budget across all rooms in the process
memory.maxRoomBytes    per-room cap
memory.onExceeded      "reject" (phase 1) | "evict" | "spill" (phase 3)
memory.idleEvictMs     zero-client rooms flush, release lease, drop state
```

Phase 1 implements accounting plus `"reject"`, so the cliff surfaces as a typed
error instead of an OOM. `"spill"` (fall back to DuckDB-over-Parquet reads) is
the escape hatch that stops in-memory from being a hard product limit, and it is
the strongest reason DuckDB is in this design at all — but it needs the Parquet
layer, so it waits for phase 3.

## Shutdown

Fly replaces machines constantly. A `SIGTERM` without a flush drops the buffer,
which under `"buffered"` is silent loss on **every deploy**.

```ts
async close() {
  stopAcceptingWrites();
  await flush();                    // bounded by shutdownFlushMs, default 5s
  await stopFlushLoop();            // bounded
  await releaseLease();             // bounded; failover becomes ~0, not leaseTtl
}
```

**Every step is bounded, not just the drain.** An in-flight request cannot be
cancelled — `fetch` is on the wire and the store decides when it answers — so an
unbounded wait anywhere here lets a hung store hold the process open through a
SIGTERM until the platform's kill timer fires. That is strictly worse than
abandoning a loop that is already unable to make progress: nothing is left
half-written, because a segment PUT is a single write and the manifest only
advances after it lands.

Lease release on clean shutdown is what lets the TTL be long, which is what makes
idle rooms cost nothing. The three decisions are load-bearing on each other.

## Compaction and GC

Activity-gated flushing has one sharp edge: under sustained load it produces many
tiny segments. An hour of active drawing at one flush per 200ms is ~18,000
segments, and boot then needs 18,000 GETs. Boot time degrades linearly with
write volume.

So activity-gated flush **requires** a compaction companion, triggered on segment
count rather than on a clock:

```
when walSegs.length >= compaction.afterSegments (200)
   or walBytes    >= compaction.afterBytes (64MB):

  write snap/<token>-<seq>     full materialized row state
  CAS manifest { snapHlc, walSegs: [] }
  schedule delayed GC of the superseded segments
                              (never of a key the manifest still names)
```

Still activity-gated: segment count only grows from writes, so idle stays free.

**GC must be delayed.** A reader that fetched the old manifest may be mid-GET of
a segment the new manifest dropped. Deleting immediately gives it a 404.
`compaction.gcGraceMs` defaults to 1 hour.

### Compaction must advance the resume cutoff

The sharpest edge in the design, because it fails silently.

A snapshot carries rows and reservations but **no ops**, and the compaction CAS
clears `walSegs`. So after the next restart the op ring holds only the segments
written since that compaction — everything older is gone.

`handleResume` in `src/server/handler.ts` rejects a client whose watermark
predates `getMeta("compactionCutoff")`. With no cutoff recorded it takes the
other branch instead: it asks `getChangedTablesSince`, gets `[]` from the
truncated ring, and tells the client nothing changed. The client then sits on
arbitrarily stale rows forever, and nothing raises an error anywhere.

`CompactionManager` states the contract for the SQL adapters — *commit the cutoff
first, then lazily delete ops*. This adapter's own compaction is bound by the
same rule: whatever makes ops unavailable owns advancing the cutoff.

It is written inside the same CAS that clears `walSegs`, so there is no window
where the ops are gone but the cutoff still says otherwise, and it only ever
moves forward — a cutoff that went backwards would start admitting resumes it had
already correctly rejected.

## Provider compatibility

DuckDB compatibility is uniform — `TYPE s3` with `ENDPOINT` and `URL_STYLE`
covers every S3-compatible store. **Conditional-write support is where providers
actually differ**, and that is what this design depends on:

| Provider | `If-None-Match: *` | `If-Match: <etag>` | Notes |
|---|---|---|---|
| AWS S3 | yes (Aug 2024) | yes (Nov 2024) | S3 Express One Zone also, ~10ms |
| Cloudflare R2 | yes | yes | zero egress — best for phase 4 client bootstrap |
| Tigris | yes | yes | Fly-native, colocated, no egress |
| GCS | yes | yes | native uses `x-goog-if-generation-match`; verify via S3 interop |
| MinIO | **no wildcard** | yes | exact etag only; needs `init()`, see below |
| Backblaze B2 | no | no | not viable as primary store |

### The MinIO gotcha

MinIO shipped conditional writes in February 2023, before AWS, but never accepted
the `*` wildcard — it requires an exact etag. `create-if-absent` therefore does
not work.

Resolution: the driver declares `caps.casWildcard`. When false, the store
requires a one-time **`init()`** that unconditionally writes an unowned `_lease`
and an empty `_manifest`. Every subsequent write is `If-Match: <etag>`, which
MinIO supports fine.

`init()` is a **deploy step, not something N racing servers run**. Concurrent
first-init on a non-wildcard driver is unsafe and the adapter says so.

`caps.casWildcard` is a capability the driver reports, not a user setting.

## The driver interface

Four methods. Everything above sits on top and never learns which provider it is
talking to.

```ts
interface ObjectDriver {
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
  put(key: string, body: Uint8Array,
      opts?: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<string>;  // → etag, throws PreconditionFailed
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  delete(keys: string[]): Promise<void>;
  readonly caps: { casWildcard: boolean };
}
```

Three implementations:

- **memory** — with fault injection (412 storms, 500s, latency). Ships in phase 1,
  not after: CAS races are the hard part of this design and they do not reproduce
  naturally.
- **filesystem** — same semantics via atomic rename; makes the whole suite runnable
  with no network.
- **s3** — SigV4 over `fetch`. Must use WebCrypto (`crypto.subtle`), never
  `node:crypto`: `bunup.config.ts` builds `src/` with `target: "browser"` and a
  `node:` import anywhere in `src/` breaks every consumer's bundle. See
  `src/server/node-require.ts` for the one sanctioned escape hatch.

### Two clients, two roles

DuckDB's `httpfs` **cannot do conditional writes** — it reads and bulk-writes
files, and exposes no `If-Match` surface. It therefore cannot be the CAS
primitive.

| Plane | Client | Job |
|---|---|---|
| Control | raw S3 REST (this driver) | lease CAS, manifest CAS, WAL PUT, GC |
| Data | DuckDB `httpfs` | Parquet snapshot read/write, compaction, boot, time travel |

One user-facing config maps to both. DuckDB stays fully optional, and phase 1
ships without it.

DuckDB config, when it lands, uses one code path for every provider:

```sql
CREATE OR REPLACE SECRET reflect (
  TYPE s3, PROVIDER config,
  KEY_ID '...', SECRET '...', REGION 'auto',
  ENDPOINT 't3.storage.dev', URL_STYLE 'vhost',
  SCOPE 's3://my-bucket/rooms/'    -- scope it; an unscoped secret applies to every s3:// path
);
```

Skip DuckDB's dedicated `TYPE r2` / `TYPE gcs` secrets. They are convenience
wrappers (`r2` derives the endpoint from `ACCOUNT_ID`; `gcs` hardcodes an
endpoint and accepts HMAC keys only) that would fork the config into three shapes
for no gain.

## Configuration

```ts
interface ObjectStorageConfig {
  // ── must expose: no sane default exists ──────────────────────
  store?: {
    provider?: "aws" | "r2" | "tigris" | "minio" | "gcs";  // preset fills endpoint/urlStyle
    bucket: string;
    prefix?: string;
    endpoint?: string;
    region?: string;                                        // "auto"
    urlStyle?: "vhost" | "path";
    credentials: { keyId: string; secret: string; sessionToken?: string }
               | "credential_chain";
    accountId?: string;                                     // R2: derives the endpoint
  };
  driver?: ObjectDriver;                 // instead of `store`: filesystem, memory, your own
  roomId: string;
  writerId?: string;                     // random; set it to make lease ownership legible

  durability?: "durable" | "buffered";   // "durable" — see Durability model
  retentionMs?: number;                  // Infinity
  concurrency?: "single-writer" | "optimistic";  // see Concurrency modes

  // ── should expose: workload-dependent ────────────────────────
  batch?: {
    maxBytes?: number;                   // 4 MiB
    minLingerMs?: number;                // 5
    maxBufferBytes?: number;             // 64 MiB
    onBackpressure?: "reject" | "degrade";  // "reject"
  };
  compaction?: {
    afterSegments?: number;              // 200
    afterBytes?: number;                 // 64 MiB
    gcGraceMs?: number;                  // 3_600_000
  };
  lease?: {
    ttlMs?: number;                      // 300_000
    renewMs?: number;                    // 120_000
    mode?: "always" | "on-write";        // "on-write" — zero PUTs when idle
  };
  memory?: {
    maxTotalBytes?: number;
    maxRoomBytes?: number;
    onExceeded?: "reject" | "evict" | "spill";  // "reject"
    idleEvictMs?: number;                // 300_000
  };
  shutdownFlushMs?: number;              // 5000
  duckdb?: { enabled?: boolean };        // false in phase 1

  onDurable?: (hlc: string) => void;     // per batch; phase 2 broadcasts it
  onHealthChange?: (health: StorageHealth) => void;
}
```

### Knobs deliberately not exposed

- **`flushMs`** — self-clocking group commit removes the need, and exposing it
  invites a 10ms setting that quadruples cost for no latency gain.
- **DuckDB internals** (threads, `memory_limit`, extension paths) — derive from
  `memory.maxTotalBytes`.
- **Per-provider settings beyond the preset** — `caps.casWildcard` is detected,
  not configured.
- **Separate read/write endpoints, custom retry curves** — until someone asks.

Roughly six knobs anyone touches; the rest exist for the one person who needs
them. Phase 1 with only `store` and `roomId` set is the intended starting surface.

## Known limits

- **No cross-room transactions.** `src/server/tx-atomic.ts` scope is room-local.
- **Read fanout caps at one machine.** Single writer per room means one machine's
  connection limit. A ten-thousand-viewer room needs read-only followers tailing
  the manifest (lag = flush + poll). Deferred.
- **Reader replicas are eventually consistent** — lag is flush plus poll. Does not
  matter while real-time fanout is WS from the writer.
- **Hard delete versus immutable segments.** Object storage makes infinite
  retention nearly free, which makes GDPR-style hard delete expensive:
  `retentionMs` needs a compaction pass that actually drops tombstoned rows
  rather than marking them. Deferred to the Parquet phase.
- **Boot thundering herd.** Five hundred rooms waking at once is a GET storm;
  needs a concurrent-boot cap once one process hosts many rooms.
- **A fenced writer keeps serving reads.** Once the manifest CAS is lost, buffered
  writes are rejected — but the mutations they carried are already in memory
  (`submit` mutates before appending), so the room goes on answering `getRow` /
  `getRows` from a view that diverges from the store and from the new writer's.
  `health` flips to `"unavailable"`, and nothing currently acts on it. Whether
  reads should fail closed once fenced is an open decision, not an oversight;
  failing closed trades a stale read for an outage, and which is worse depends on
  the app.
- **`batch.maxBytes` counts UTF-16 units, not bytes.** `JSON.stringify(...).length`
  under-counts non-Latin text by up to 3x, so a 4 MiB cap can emit a ~12 MiB
  object. Internally consistent — the same estimate is added and subtracted, so
  nothing desyncs — but the cap does not mean quite what it says.
- **`pendingGc.deletableAt` is stamped with the compacting writer's clock** and
  compared against a possibly different writer's clock after a failover.
  Immaterial at the 1 hour default; it would matter if `gcGraceMs` were lowered
  to seconds.

## Deferred work

Recorded so a later phase cannot silently default the wrong way.

### Direct-from-bucket client bootstrap breaks the ACL model

Phase 4 (client GETs a snapshot straight from the bucket via presigned URL)
collides with `src/server/enforcement.ts` and per-user query results. **A snapshot
object has one ACL.** It cannot be filtered per user. Handing a client a
presigned URL gives them every row in that table regardless of what their query
would have returned.

Direct bootstrap is therefore legal **only when room membership is the entire
access check** for that table. It must be opt-in and explicit:

```ts
query("strokes", { bootstrap: "direct" })   // room ACL is the whole ACL
query("dms",     { bootstrap: "server" })   // default
```

Default `"server"`. A silent default to `"direct"` is a data breach, not a
performance regression.

### Row encoding

Rows are `Record<string, unknown>` plus a `colClocks` map, both dynamic. Two
options for the Parquet phase:

- **JSON blob columns** — `tbl, row_id, data, col_clocks, hlc`, mirroring the
  SQLite table. Trivial, no schema registry. **Chosen for phase 1.**
- **Typed columns** derived from `src/core/schema.ts` — columnar, unlocks
  analytics and time-travel queries.

Opt-in per table when the Parquet layer lands. Do not try to auto-infer.

### Cold op-log tier

The op log is append-only and HLC-ordered, which is exactly Parquet's shape. Once
`snap/` is Parquet, `getOpsSince` for a long-offline client can union hot
in-memory ops with cold Parquet segments in one DuckDB query, and DuckDB can
`ATTACH` SQLite and Postgres directly so the same trick works for the existing
adapters.

## Phases

1. **Adapter on object storage.** *Shipped.* Driver interface; memory +
   filesystem + S3 drivers; lease, manifest, group commit, WAL replay, JSON
   snapshots; backpressure, health, memory accounting, shutdown flush; plus
   `concurrency: "optimistic"` and `refresh()` for platforms that cannot route a
   room to one instance. No DuckDB, no Parquet. Passes
   `test/server/storage/storage-adapter-suite.ts`.
2. **Durable watermark protocol.** `durableHlc` broadcast, client retires pending
   ops against it. Unlocks a safe `"buffered"`. Room-affinity routing; retire the
   shared-storage HA polling path for this adapter.
3. **DuckDB data plane.** Parquet snapshots, compaction as `COPY ... TO
   's3://...'`, boot-from-Parquet, `memory.onExceeded: "spill"`, cold op-log tier.
4. **Direct-from-bucket bootstrap.** Presigned snapshot plus server delta, gated
   on the per-table `bootstrap` opt-in above.
