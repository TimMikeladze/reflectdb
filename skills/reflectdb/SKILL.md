---
name: reflectdb
description: Use when adding ReflectDB to a TypeScript app, defining synced queries, connecting clients, configuring persistence or transports, adding presence or WebRTC, or debugging ReflectDB sync, offline replay, conflicts, and authorization.
---

# ReflectDB

Build or fix the ReflectDB integration requested in the current conversation.
Use the request accompanying the skill invocation as the task. If invoked
without a task, inspect the current integration and ask which behavior to add
or fix. This skill works in Claude Code and Codex using their available file,
shell, and browsing tools.

## Find the matching API

Inspect the app's package manifest and lockfile to identify the ReflectDB
version, runtime, framework, database, and transport. Preserve the app's stack.
Install `reflectdb` with its existing package manager when needed; add optional
peers only for the integrations in use.

Use the installed package's exports and declarations to verify signatures.
In the ReflectDB repository, inspect `src/` and the relevant tests instead.
Read [integration.md](references/integration.md) for the typed schema, server,
and client pattern. The reference targets ReflectDB 0.4.1; adapt it to the
installed declarations when versions differ.

For recipes beyond the reference, read the matching section in the package's
README or the repository README. Online fallback:
<https://github.com/TimMikeladze/reflectdb#readme>.
Check version-specific source when current online docs differ from the
installed package. Resolve reference paths relative to this skill directory,
not the app's working directory.

## Implement sync

1. Define shared queries with `defineSyncQueries` and `t<Row>()`, or infer rows
   from existing Drizzle tables. Declare typed params for scoped subscriptions.
   Keep server database handles and secrets out of browser imports.
2. Create the server with `createSyncServer`. Implement each writable query's
   reads and mutations against the app's database. Authenticate connections
   with the app's existing session verification, and authorize scoped reads
   and writes from the authenticated context.
3. Wire a transport supported by the deployment. Use WebSocket for a process
   that can hold connections; use SSE or polling where HTTP fits. Connect
   lifecycle handlers. In 0.4.1, `server.auth` receives a synthesized request
   whose Bearer header contains the client's `token`, not upgrade cookies.
   Bridge an existing cookie session to a verified sync token when needed.
4. Connect through the matching typed client or framework factory. Use
   IndexedDB when offline data and queued writes must survive a reload.
   Namespace browser storage by authenticated user, keep instances stable,
   and remount the provider when identity changes. Unmount it on logout and
   apply the app's local-cache deletion policy. Supply `onReauth` for token
   refresh; changing the token prop alone does not reauthenticate a client.
5. Verify the changed path with the app's type check and a focused test or
   running example. For sync changes, check two clients receiving the same
   accepted write; for offline changes, check a queued write after reconnect.
   Report the behavior actually checked and any verification left undone.

## Preserve these contracts

- **Two stores:** `db` holds application rows; server `storage` holds sync rows,
  clocks, and the op log. Persisting the op log does not persist an in-memory
  application Map. Configure both according to the durability requirement.
  `createSqliteStorage` requires Bun; use a compatible adapter on Node.
- **Mutations:** the row ID is a separate argument. Updates are partial
  patches, so merge them into the existing row or use an SQL update. Implement
  deletion explicitly. `t<Row>()` provides no runtime validation: validate
  incoming fields and distinguish insert requirements from update patches.
- **Ownership:** omit `id`, `readonly`, and `serverSet` fields from client
  payloads. Array-form `serverSet` needs values in `implement`; object-form
  declarations can supply values in the schema. Use authenticated context for
  ownership fields, and authorize against stored rows for writes.
- **Isolation:** params and room names come from clients. Verify membership,
  scope database reads and mutations, and set `room` in `implement` when a
  query requires that room pattern. Only share results with `groupBy` when
  every subscriber in the group is allowed the identical rows and fields.
- **Delivery:** `lww` compares row timestamps; `merge` compares per-column
  timestamps for concurrent field edits. Both accept partial update patches.
  Use schema `presence()` or ephemeral channels for cursors and
  typing. Views use `view()` and `server.view()` and reject writes. Keep
  persisted data on the durable sync path.

## Choose the integration

| Need                         | Entry point or reference                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Shared schema                | `reflectdb/core` (also exported by `reflectdb`)                                                                             |
| Server and op log adapters   | `reflectdb/server`; Drizzle helpers at `reflectdb/server/drizzle`                                                           |
| Framework-independent client | `createSyncClient` from `reflectdb/client`                                                                                  |
| React                        | `createSyncReact` from `reflectdb/react`; its provider uses WebSocket                                                       |
| Svelte, vanilla JS, htmx     | `createSyncSvelte`, `createSyncVanilla`, `createSyncHtmx` from their corresponding subpaths; inspect each factory's options |

For serverless SSE, read the README's “Serverless sync on Vercel” recipe:
both transport ends need `serverless: true` and POST responses must return
`collectReplies`. Use a client accepting a custom transport; React's standard
`SyncProvider` takes a WebSocket URL, not a transport prop.

For object storage, read `docs/object-storage.md` in a ReflectDB checkout or
<https://github.com/TimMikeladze/reflectdb/blob/main/docs/object-storage.md>.
For peer meshes, calls, screen share, or TURN, read `docs/webrtc.md` or
<https://github.com/TimMikeladze/reflectdb/blob/main/docs/webrtc.md> and verify
the installed `reflectdb/client/webrtc` and `reflectdb/react/webrtc` exports.

## Diagnose sync failures

Trace one failing write through the transport, authentication, subscription,
authorization, mutation, op acknowledgment, and recipient query result.
Capture the actual rejection reason before changing config.

| Symptom                                 | Inspect first                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Connected but no rows                   | Declared subscription, required params, bootstrap/resume, query result, room access       |
| Local write disappears                  | Rejected op, runtime validation, authorization, conflict policy, partial-update handling  |
| Rows disappear on restart               | Application database persistence separately from op log storage                           |
| Offline edits disappear on reload       | IndexedDB adapter, storage hydration, client identity, pending-op replay                  |
| Server-side write never reaches clients | ReflectDB write/transaction API or explicit notification after an external database write |

Use the relevant tests as protocol examples when working in this repository.
Keep fixes scoped to the failing path; finish with the observed before/after
behavior and verification result.
