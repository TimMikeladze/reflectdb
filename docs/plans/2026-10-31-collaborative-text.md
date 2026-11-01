# Collaborative text

Two people typing in one value both keep their edits, with no CRDT. Declared with
`conflict: { policy: "merge", text: [...] }`, edited with `client.text()` and `useText()`.
Built for devbar's co-edited drafts: one row per markdown block.

## How it works

A client sends `$text: { who, n, edits: { [column]: { value, back } } }`, where `back` turns `value`
into the text it was based on. The resolver runs `merge3(base, row, value)` and stamps `_seen[who] = n`.
One write per binding is in flight. When `_seen` reaches it, the store's text includes that write, and
the binding merges anything typed since.

## Decisions

- **`_seen` instead of `ack` carrying the row.** An ack can't be ordered against deltas for the same row,
  so a writer can't tell whether a delta it just got includes its write. `_seen` travels in the same delta
  as the text. It costs a column the user's `mutate` and `query` have to carry.
- **The store's row is never optimistic for text.** A patch only applies to exactly what the server's
  result cache thinks the client holds. The binding holds the typing.
- **No multiple subscriptions per table.** It touches the protocol, the result cache and every write
  path, because a write would have to say which subscription it belongs to. `sync()` with new params now
  works, and a client on one page at a time doesn't need more.
- **`sync()` when connected bootstraps.** A declare alone returns no rows. It re-snapshots every synced
  table, which is wasteful and simple. A per-table bootstrap can come if it shows up in profiles.

## Fixes this needed

- `writerHeldColumns` claimed the writer held whatever a resolver returned, so it was never told.
- A writer was excluded from its own broadcast even when the resolver changed its write.
- Read, resolve and write spanned an await, so two clients on one row overwrote each other's merge. Now
  there's a queue per row, and writes mark other batches' prefetched rows stale.
- `applyOpIf` makes that hold across machines. With it turned off, the two-server Postgres test fails.
- Eager deltas skipped the result cache, so a later server delete never reached peers.
