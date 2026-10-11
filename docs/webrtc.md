# WebRTC for ephemeral traffic

Status: built — phases 1–3 and the bindings. A landing-page demo is not built yet.

## What and why

High-frequency ephemeral traffic (cursors, drags, game ticks) and media (calls,
screen share) go peer-to-peer over WebRTC. reflectdb's own connection does the
signaling, so apps need no extra infrastructure beyond an optional TURN server.

Durable data never goes P2P. Ops, permissions, and ordering stay on the server.
WebRTC changes only the route an ephemeral frame takes; the server path remains the
source of truth and the fallback.

Use cases, in build order:

| #   | Use case                           | Rides on                                    |
| --- | ---------------------------------- | ------------------------------------------- |
| 1   | Live cursors / selections          | data channel, unreliable                    |
| 3   | Drag previews, in-progress strokes | data channel, unreliable; commit via ops    |
| 4   | Multiplayer game state             | data channel, unreliable, P2P-only option   |
| 5a  | Follow mode (viewport)             | data channel — same as #1, a `viewport` key |
| 2   | Voice/video huddle                 | media tracks                                |
| 5b  | Screen share                       | media track (`getDisplayMedia`)             |

## Today's gap

`ephemeral` messages are broadcast to every room subscriber and written to the
presence store. Signaling needs the opposite: one recipient, never stored (an SDP
offer must not appear in a joiner's presence snapshot). So the server gains one
message type, and the client gains one entrypoint.

## Server: `signal` message

```ts
// Client → Server
interface SignalMessage {
	type: "signal";
	to: string;
	data: Record<string, unknown>;
}
// Server → Client
interface SignalEvent {
	type: "signal";
	from: string;
	userId: string;
	data: Record<string, unknown>;
}
```

- **Targeted, not stored.** Delivered to the client `to` only. Never touches `EphemeralAdapter.set`.
- **Authorization: shared room.** Delivered only if sender and recipient share at
  least one subscription with the same room, matched exactly. A sender whose
  subscription has no room reaches only recipients whose subscription to that query
  also has none, never a client inside a room. The sender's rooms are resolved on the origin
  instance (same as `targets` today); the recipient check runs on the instance
  holding the recipient's socket. No shared room means a silent drop, so a client cannot
  probe for the existence of another client ID.
- **`from` and `userId` come from the session**, never from the client.
- **Metered** in the existing ephemeral bucket (`ephemeralPerSecond`). Signaling
  is a few dozen messages per connection, far below the limit.
- **Size cap 4 KB** per signal; larger frames are dropped. The cap stays under the
  Postgres NOTIFY limit (8000 bytes) with room for the envelope. A video SDP can run
  several KB, so the mesh splits descriptions into 1500-character `part` frames and
  reassembles them.
- **Across a fleet:** `EphemeralBroadcast` gains optional `to?: string` and
  `kind?: "signal"`. Existing adapters carry it unchanged (they serialize the whole
  event), so Redis, Postgres, and memory need no changes. `deliverRemoteEphemeral`
  routes `kind: "signal"` to the one socket if it is local and shares a target room.
- **No protocol version bump.** An old server rejects `signal` as an unknown type, so
  no peer ever connects. The mesh gives up after `connectTimeoutMs` (15 s) and stays on
  the server path.
- **`hello_ack` carries `clientId`**, the server's id for the connection. Peers see each
  other by that id, and the transport chooses it, so it can differ from the client's
  configured `clientId`. `SyncClient.getClientId()` returns it once connected. A mesh
  that sees it change after a reconnect drops its peers and starts over.

## Client: `reflectdb/client/webrtc`

Lives in its own entrypoint and does not touch the core bundle. Imports nothing from the rest of the library.

```ts
import { createPeerMesh } from "reflectdb/client/webrtc";

const mesh = createPeerMesh(client, {
	iceServers: [{ urls: "stun:stun.l.google.com:19302" } /* TURN */],
	maxPeers: 8, // full-mesh ceiling; peers past it stay on the server path
	relayOnly: false, // true = iceTransportPolicy "relay": hides peer IPs, needs TURN
});
mesh.getSnapshot(); // { peers: PeerInfo[], call: CallState | null }
mesh.subscribe(listener); // for useSyncExternalStore or any store
mesh.destroy();
```

**Peer discovery.** Discovery uses existing presence: each mesh announces itself on the
reserved ephemeral key `__rtc` (`{ v: 1 }`, refreshed every `announceIntervalMs`, default
30 s, with a TTL of three intervals). Each refresh fans out to the whole room, so the
cost is O(room²) messages per interval; discovery never waits on a refresh (see below).
A
peer appears via the presence snapshot or a live `__rtc` event, and leaves when that entry
expires or the connection closes.

**Negotiation.** This is the standard "perfect negotiation" pattern. The lower `clientId`
opens the connection and is impolite; the higher one is polite and yields on an offer
collision. Both sides agree without a round-trip.

**Failure.** Two cases, handled differently:

- _Never connected_ within `connectTimeoutMs`: the peer is marked `server-only` and stays
  on the server path. After a 60 s cool-down, its next announce or offer starts a fresh
  attempt. If it falls silent for three announce intervals, it is dropped.
- _Connected, then lost_ (`disconnected` or `failed`): the peer leaves the direct path at
  once (state `connecting`, so `auto` stops throttling for it). ICE is restarted on
  `failed`, at most twice. If the connection has not recovered within
  `connectTimeoutMs`, the peer is treated as gone and dropped until it announces again.
  A clean close from the far side (including a closing tab, which closes its
  connections on `pagehide`) drops the peer immediately.

**Signals are handled one at a time, in arrival order**, so an answer is never built
while the offer before it is still being applied.

**`call()` and `shareScreen()` are idempotent while a capture is pending.** A second
call waits on the first rather than opening the device again. `leave()` stops every
local track, including those of a stream the app passed in.

**Channels per peer.**

- `eph` — `{ ordered: false, maxRetransmits: 0 }`. Ephemeral frames.
- `ctl` — reliable, JSON. The whole control vocabulary:
  - `{ t: "call", on: boolean }`: joined or left the call.
  - `{ t: "stream", id, kind: "camera" | "screen" }`: label for a stream's tracks, sent before they are added.
  - `{ t: "unstream", id }`: that stream was removed.
  - `{ t: "mute", audio: boolean, video: boolean }`: current mute state.

## Routing ephemeral frames

`sendEphemeral` / `useEphemeral` gain `transport`:

| `transport`                         | P2P-connected peers | Everyone else | Server store / joiner snapshot                                    |
| ----------------------------------- | ------------------- | ------------- | ----------------------------------------------------------------- |
| `"server"` (default without a mesh) | server              | server        | every frame                                                       |
| `"auto"` (default with a mesh)      | P2P every frame     | server        | throttled while every known peer is direct; every frame otherwise |
| `"p2p"`                             | P2P every frame     | nothing       | nothing                                                           |

- **`auto` throttle.** While every peer the mesh knows of is connected directly, the
  server copy goes out at most every 100 ms per key (leading and trailing edge, so the
  final position always lands). Joiner snapshots and clients without a mesh then see
  10 Hz while connected peers get 60 Hz. As soon as any known peer is not direct, every
  frame also goes through the server, and a parked trailing frame is dropped, so the
  server never ends on a stale value.
- **Dedupe.** Every frame carries `seq` (monotonic per client and key). A receiver keeps
  the highest `seq` per (clientId, key) and drops older frames. That covers the same
  frame arriving over both paths and out-of-order data channel delivery. `seq` sits
  in a reserved `__seq` field of `data`, so the wire protocol is unchanged.
- **`p2p`** is for game ticks (#4). Never stored, never seen by peers past `maxPeers`.
  The game must tolerate this; authoritative state belongs in ops.
- Drag previews (#3) use `auto`. The drop is an ordinary mutation, and the preview
  key is cleared on drop.
- Follow mode (#5a) is the `viewport` key on `auto`. It needs no new API, only a documented recipe.

## Media (#2, #5b)

```ts
await mesh.call(); // camera + mic; or mesh.call(stream) with your own MediaStream
await mesh.shareScreen(); // adds a "screen" stream alongside the camera
mesh.getSnapshot().call?.participants; // [{ clientId, userId, camera, screen, audioMuted, videoMuted }]
mesh.setMuted({ audio: true });
mesh.leave(); // also cancels a join still waiting on the camera prompt
```

- A call is opt-in per peer. Joining sets the `__rtc` presence entry to `{ v: 1, call: true }`.
  Tracks flow only between peers that have both joined, and are added via renegotiation on the
  existing connection.
- `ctl` carries `{ t: "stream", id, kind: "camera" | "screen" }` before the tracks are
  added, so the receiver can tell a screen apart from a camera.
- Full mesh only. Above ~6 video participants, uplink bandwidth becomes the limit. The doc
  says so and points to an SFU (LiveKit, Cloudflare Calls); building an SFU is out of scope.

## Bindings

- React: `<PeerMeshProvider iceServers>`, `usePeers()`, `useCall()`; `useEphemeral`
  accepts `transport`. Svelte and vanilla ephemeral bindings accept `transport`; the
  mesh itself is framework-agnostic (`getSnapshot` / `subscribe`). htmx is out: there
  is no client JS to own a mesh.

## Security notes (for the README)

- Peers in a room see each other's IP addresses through ICE candidates. Use `relayOnly: true` with TURN to
  hide them.
- A malicious peer can send anything on the data channel. Validate P2P frames like
  untrusted input; the server rate limit no longer applies to them.
- The `userId` on a P2P frame is whatever the peer claims. The mesh stamps the
  `userId` learned through server-relayed signaling, not the frame's own value.

**Discovery without a snapshot.** Rooms that have no presence snapshot (queries with
no room) only learn of a peer when it announces. When a peer with a lower id
announces, the higher-id peer replies with a targeted `hello` signal, so the lower-id
peer can open the connection immediately instead of waiting for the next announce.

## Testing

- **Server (bun test):** signal routing on one node; delivery across instances through an
  in-process bus that round-trips events through JSON, as Redis and Postgres do (both
  carry the event opaquely, so they need no signal-specific code); the no-shared-room
  drop; the size cap.
- **Client (bun test):** real data channels through `node-datachannel`'s polyfill
  (a dev dependency): connect, `p2p` delivery, `auto` throttle, fallback, connection-id
  identity, and discovery without a snapshot. The polyfill never fires
  `negotiationneeded`, so the test restores that one event. `seq` dedupe and routing
  without a mesh are unit-tested on `SyncClient`.
- **Real WebRTC:** two tabs on `test/ui` checked with the browser agent: cursors over P2P (the server
  frame rate drops to 10 Hz), then a call with a screen share.

## Phases

1. `signal` message, server and fleet routing, and tests.
2. `createPeerMesh` with data channels, `transport` routing and dedupe, and the React hooks. Covers #1, #3, #4, #5a.
3. Media: `call`, `shareScreen`, `useCall`. Covers #2 and #5b.
4. README section and a `transport` option on the Svelte and vanilla ephemeral bindings
   (both done). The mesh itself is framework-agnostic (`getSnapshot` / `subscribe`), so
   it needs no per-framework wrapper. A landing-page demo is still to do.

## Decided

- `auto` is the default whenever a mesh exists. `transport: "server"` opts a key out.
- `call()` and `shareScreen()` accept a ready `MediaStream` as well as capture
  constraints, for processed video, canvas sources, and tests that avoid a permission prompt.
- `iceServers` defaults to Google's public STUN (`stun:stun.l.google.com:19302`). No TURN ships by default; apps supply their own.
