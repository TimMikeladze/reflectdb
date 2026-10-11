# Huddle — reflectdb over WebRTC

A shared board for a small group: sticky notes, live cursors, and a video huddle with
screen share. Open it in two tabs (or send the link) and watch the stats panel. Your
cursor moves at full frame rate peer-to-peer, while the server receives about ten
frames a second.

**Live:** https://reflectdb-huddle.fly.dev/

## What it shows

| On screen       | reflectdb feature                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Cursors         | `useEphemeral({ key: "cursor" })` under `<PeerMeshProvider>`. Same code as a server-only cursor, routed peer-to-peer.              |
| Dragging a note | The drag preview is ephemeral and goes peer-to-peer. The drop is an ordinary `update` op through the server.                       |
| Stats panel     | Frames you sent per second against frames the server saw from you (`/stats`), and each peer's route: direct or through the server. |
| Huddle          | `useCall()`: camera and mic, or an animated test pattern if you have no camera, plus screen share.                                 |
| Room link       | `?room=` scopes everything: notes sync with `{ roomId }`, and signaling only reaches peers in the same room.                       |

## Design

- **Server** (`server.ts`): Bun plus `createBunWsServerTransport`. Notes live in memory
  (`Map<roomId, Map<id, Note>>`) and are scoped by `server.room("huddle/:roomId")`.
  Each room holds at most 24 notes and the server at most 500 rooms. Inserts past
  either cap are rejected with `MutationError`. Note text is trimmed to 140 characters
  and positions are clamped to the board. The Fly Machine auto-stops when idle, so
  rooms disappear with it. That is by design.
- **`/stats`**: the server counts the `cursor` ephemeral frames each connection sends
  and reports the last full second, which is how the page shows the server's side of
  the throttle.
- **Client** (`app.tsx`): plain React hooks, with no generated types needed. Positions
  are fractions of the board (0–1), so screens of different sizes agree. A new room
  gets three starter notes with deterministic ids, so two tabs loading at once don't
  duplicate them.
- **Privacy**: a room is private by default. A visit without `?room=` creates a random
  one, and the camera starts only when you press "join". There is no shared lobby
  where strangers could see each other's cameras.

## Run it

```bash
cd examples/huddle
bun install
bun run dev        # http://localhost:3006, or the next free port
```

## Deploy

`fly.toml` makes the example deployable: the `Deploy demos` workflow picks it up after
CI passes on `main`, using the `FLY_API_TOKEN_REFLECTDB_HUDDLE` repository secret.
