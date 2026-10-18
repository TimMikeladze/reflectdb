# Typed integration

This example targets ReflectDB 0.4.1. Use the app's runtime and database;
the Bun transport and in-memory Map below are an example for local development.
The Map loses application rows on process exit.

## Shared schema

```ts
// schema.ts
import { defineSyncQueries, t } from "reflectdb/core";

export type Todo = { id: string; title: string; done: boolean };

export const queries = defineSyncQueries({
	todos: { row: t<Todo>(), conflict: "merge" },
});
```

## Server

```ts
// server.ts
import { createSyncServer } from "reflectdb/server";
import { createBunWsServerTransport } from "reflectdb/transport/bun-ws";
import { queries, type Todo } from "./schema";

const db = new Map<string, Todo>();
const { transport, websocket } = createBunWsServerTransport();
const server = createSyncServer({
	queries,
	db,
	transport,
	serverId: "local-dev",
});

// Local demo identity. Replace with the app's session verification before
// exposing this endpoint. Scope queries and authorize writes for private data.
server.auth(async () => ({ userId: "local-demo" }));

server.implement("todos", {
	query: (_ctx, db) => [...db.values()],
	mutate: async (op, _ctx, db) => {
		if (op.type === "delete") {
			db.delete(op.rowId);
			return;
		}

		const patch = op.payload ?? {};
		if (Object.keys(patch).some((key) => key !== "title" && key !== "done")) {
			throw new Error("Unknown todo field");
		}
		if ("title" in patch && typeof patch.title !== "string") {
			throw new Error("title must be a string");
		}
		if ("done" in patch && typeof patch.done !== "boolean") {
			throw new Error("done must be a boolean");
		}

		const existing = db.get(op.rowId);
		if (op.type === "update" && !existing) {
			throw new Error("Todo not found");
		}
		const row = { ...existing, ...patch, id: op.rowId };
		if (typeof row.title !== "string" || typeof row.done !== "boolean") {
			throw new Error("title and done are required");
		}
		db.set(op.rowId, { id: row.id, title: row.title, done: row.done });
	},
});

const http = Bun.serve({
	port: Number(process.env.PORT ?? 0), // 0 chooses an available port.
	websocket,
	fetch(req, srv) {
		if (new URL(req.url).pathname === "/sync") {
			if (srv.upgrade(req, { data: { id: crypto.randomUUID(), req } })) return;
			return new Response("WebSocket upgrade required", { status: 426 });
		}
		return new Response("Not found", { status: 404 });
	},
});
console.log(`Sync endpoint: ws://localhost:${http.port}/sync`);
```

In 0.4.1, `server.auth` receives a synthesized request with
`Authorization: Bearer <client token>`. The upgrade request's cookies and
headers are not passed through to that callback, even though the transport
receives `req`. Use the app's token verifier, or exchange an authenticated
cookie session for a sync token through the app's existing HTTP auth flow.
In an existing app, mount the transport on its HTTP server instead of creating
a second listener. Use `wss:` on HTTPS pages.

## React client

```tsx
// sync.ts
import { createSyncReact } from "reflectdb/react";
import { queries } from "./schema";

export const { SyncProvider, useSync, useSyncStatus } = createSyncReact(queries);
```

```tsx
// app.tsx (browser entry)
import { useMemo } from "react";
import { createIndexedDBStorage } from "reflectdb/client/storage/indexeddb";
import { SyncProvider, useSync } from "./sync";

export function App({
	url,
	token,
	userId,
	refreshToken,
}: {
	url: string;
	token: string;
	userId: string;
	refreshToken: () => Promise<string>;
}) {
	const storage = useMemo(
		() => createIndexedDBStorage({ dbName: `todos-demo:${userId}` }),
		[userId],
	);
	return (
		<SyncProvider
			key={userId}
			url={url}
			token={token}
			tables={["todos"]}
			storage={storage}
			onReauth={refreshToken}
		>
			<Todos />
		</SyncProvider>
	);
}

function Todos() {
	const { rows, insert, update, remove } = useSync("todos");
	return (
		<div>
			<button onClick={() => insert(crypto.randomUUID(), { title: "New", done: false })}>
				Add
			</button>
			{rows.map((todo) => (
				<label key={todo.id}>
					<input
						type="checkbox"
						checked={todo.done}
						onChange={() => update(todo.id, { done: !todo.done })}
					/>
					{todo.title}
					<button onClick={() => remove(todo.id)}>Delete</button>
				</label>
			))}
		</div>
	);
}
```

Use the server's printed URL and the app's session token. For this local demo,
the server accepts any token. The provider owns initialization, connection,
subscriptions listed in `tables`, resume/bootstrap, and teardown.

Mount `App` after the authenticated identity is known. User-specific storage
prevents one account from rendering another account's cached rows before the
connection authenticates. Unmount on logout and delete that account's cache
when the app's logout policy requires it. The provider key changes on account
switch; `onReauth` obtains refreshed tokens from the app's auth flow.

For required params, declare `params: t<{ projectId: string }>()` in the query
and call `useSync("todos", { params: { projectId } })`. Leave parameterized
queries out of the provider's `tables`; the hook declares that subscription.
Authorize the project on the server and filter reads and writes by it.

## Other clients

For a framework-independent client, inspect `createSyncClient` from
`reflectdb/client`. It accepts `queries`, `clientId`, `transport`, `token`, and
optional `storage`. Hydrate with `init()`, connect, declare subscriptions with
`sync(name, params)`, and call `resume()` or `bootstrap()` as appropriate. Close
the client on teardown. `autoSync: true` declares parameterless queries on
connect; it does not replace the rest of the lifecycle.

React's typed `useSync` uses `remove(id)`; the standalone client uses
`delete(name, id)`. Both take IDs separately from mutation payloads.
