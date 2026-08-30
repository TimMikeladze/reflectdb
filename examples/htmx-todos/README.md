# htmx 4 + reflectdb todos

A todo list where htmx owns the DOM and reflectdb owns the data. The server
renders no HTML at all — every fragment is produced in the browser from the
local store, so writes apply instantly, survive going offline, and re-render
the moment another tab's op arrives.

```bash
bun install
bun run dev
# open http://localhost:3005 in two tabs
```

The server takes the first free port at or above `PORT` (default 3005), so it
will not collide with the other examples.

## What to try

- Type in two tabs at once. Both lists converge without a refresh.
- Open devtools, go offline, add and tick a few todos. They render immediately
  and the badge shows how many are unsynced. Go back online — they drain.
- Click a filter. The list keeps that filter as peers' changes stream in.
- Wait a minute. The list resets to its seed rows in every open tab at once.

## How it hangs together

`client.ts` binds htmx attributes to `reflect:` actions instead of server
routes:

```html
<ul id="list" hx-get="reflect:todos" hx-trigger="load" hx-swap="innerMorph"></ul>
<form hx-post="reflect:todos">…</form>
<button hx-delete="reflect:todos/${id}">×</button>
```

`reflectdb/htmx` answers those from the local store: reads render through the
view registered with `reflect.view("todos", …)`, and writes go into the op log
and answer `204`, letting the store change drive the re-render. htmx still does
the swapping, morphing, out-of-band updates and settling — the counter in the
footer is a plain `hx-swap-oob` element riding along in the list fragment.

`server.ts` is an ordinary reflectdb sync server: a schema, an in-memory `Map`,
and a WebSocket transport. It also resets the list to three seed rows every
minute, so a shared demo does not accumulate whatever people type. Each change
goes through `server.applyServerOp` rather than clearing the `Map`: that is what
stamps an HLC, appends to the op log, updates reflectdb's mirror and broadcasts
the delta, so the reset lands in every open tab instead of only on the next
load.

## htmx 4 is not on npm's `latest` tag

htmx keeps `latest` on 2.x until early 2027 so unversioned CDN URLs do not
upgrade people by surprise; 4.x ships under the `next` tag. That is why
`package.json` pins `^4.0.0` rather than taking the default — `bun add htmx.org`
would install 2.x.

htmx is imported by `client.ts` and bundled, not loaded from a CDN, so there is
exactly one instance on the page.

`bunfig.toml` here excludes `htmx.org` from the global `minimumReleaseAge`
policy, which would otherwise refuse to resolve a release this recent.
