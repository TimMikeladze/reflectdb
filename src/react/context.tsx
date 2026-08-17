import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
// Imported by name rather than reached through the global `React` UMD
// namespace: the d.ts bundler renames these on import and then cannot rewrite a
// `React.`-qualified use, emitting a dangling `React.ReactNode2` into dist/.
import type { Context, ReactNode } from "react";
import { SyncClient } from "../client/sync-client.ts";
import type { ClientStorageAdapter } from "../client/storage/types.ts";

import type { ClientTransport, ClientMessage, ErrorReason, ServerMessage } from "../core/types.ts";

export interface SyncProviderProps {
	/** WebSocket URL to connect to (e.g., "ws://localhost:3001/sync") */
	url: string;
	/** Auth token */
	token: string;
	/** Tables to sync. Provider handles connect → sync → bootstrap lifecycle. */
	tables?: string[];
	/** Unique client ID. Auto-generated if not provided. */
	clientId?: string;
	/** Durable storage adapter for offline-first persistence (e.g., createIndexedDBStorage) */
	storage?: ClientStorageAdapter;
	/** Called when the server requests re-authentication */
	onReauth?: () => Promise<string>;
	/** Called on sync errors */
	onError?: (error: {
		opId?: string;
		batchId?: string;
		table?: string;
		reason: ErrorReason | `local:${string}`;
		message?: string;
	}) => void;
	children: ReactNode;
}

interface SyncContextValue {
	client: SyncClient;
	/** Tables managed by the provider (auto-synced) */
	managedTables: Set<string>;
}

export const SyncContext: Context<SyncContextValue | null> = createContext<SyncContextValue | null>(
	null,
);

function createBrowserWsTransport(url: string): ClientTransport {
	let ws: WebSocket | null = null;
	let handler: ((message: ServerMessage) => void) | null = null;
	let intentionalClose = false;
	const sendQueue: ClientMessage[] = [];

	function ensureConnected(): WebSocket {
		// Create a new socket if none exists or the current one is closed/closing
		if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
			return ws;
		}

		const socket = new WebSocket(url);
		socket.onopen = () => {
			for (const msg of sendQueue) {
				socket.send(JSON.stringify(msg));
			}
			sendQueue.length = 0;
		};
		socket.onmessage = (event) => {
			try {
				handler?.(JSON.parse(event.data as string));
			} catch (err) {
				console.warn(
					"[reflectdb] react WS: malformed message ignored:",
					err instanceof Error ? err.message : String(err),
				);
			}
		};
		socket.onclose = () => {
			ws = null;
			// Emit synthetic disconnect so SyncClient can trigger reconnection
			if (!intentionalClose) {
				handler?.({ type: "disconnect", reason: "transport_closed" });
			}
		};
		ws = socket;
		return socket;
	}

	return {
		async send(message: ClientMessage) {
			const socket = ensureConnected();
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(message));
			} else {
				sendQueue.push(message);
			}
		},
		subscribe(h: (message: ServerMessage) => void) {
			handler = h;
		},
		async close() {
			intentionalClose = true;
			if (ws) {
				ws.close();
				ws = null;
			}
		},
	};
}

export function SyncProvider({
	url,
	token,
	tables,
	clientId,
	storage,
	onReauth,
	onError,
	children,
}: SyncProviderProps): ReactNode {
	const [ctx, setCtx] = useState<SyncContextValue | null>(null);
	// Rebuild the Set when the `tables` prop changes. Sorted + stringified key
	// keeps the Set identity stable across renders that pass the same list.
	const tablesKey = useMemo(() => JSON.stringify([...(tables ?? [])].sort()), [tables]);
	const managedTables = useMemo(() => new Set(tables ?? []), [tablesKey]);

	// Stable refs for callback props — prevents connection teardown on parent re-render
	const onReauthRef = useRef(onReauth);
	onReauthRef.current = onReauth;
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;

	// Use a ref for token so token refresh doesn't tear down the entire client
	const tokenRef = useRef(token);
	useEffect(() => {
		tokenRef.current = token;
	}, [token]);

	useEffect(() => {
		let cancelled = false;

		const id = clientId ?? `browser-${crypto.randomUUID().slice(0, 8)}`;
		const transport = createBrowserWsTransport(url);
		const client = new SyncClient({
			clientId: id,
			transport,
			token: tokenRef.current,
			storage,
			onReauth: () => onReauthRef.current?.() ?? Promise.reject(new Error("No onReauth handler")),
			onError: (err) => onErrorRef.current?.(err),
		});

		(async () => {
			// Phase 1: Hydrate from durable storage — cached data becomes available
			if (storage) {
				await client.init();
				if (cancelled) return;
				// Set context immediately — children render cached data
				setCtx({ client, managedTables });
			}

			// Phase 2: Connect and sync — delta catch-up or full bootstrap
			await client.connect();
			if (cancelled) return;

			for (const table of managedTables) {
				await client.sync(table);
			}

			// Use resume (delta catch-up from persisted serverHlc) if available,
			// otherwise full bootstrap
			await client.resume();
			if (cancelled) return;

			// If no storage, set context after bootstrap (original behavior)
			if (!storage) {
				setCtx({ client, managedTables });
			}
		})();

		return () => {
			cancelled = true;
			setCtx(null);
			client.close();
		};
	}, [url, clientId, storage, managedTables]);

	if (!ctx) return null;

	return <SyncContext.Provider value={ctx}>{children}</SyncContext.Provider>;
}

export function useSyncClient(): SyncClient {
	const ctx = useContext(SyncContext);
	if (!ctx) {
		throw new Error("useSyncClient must be used within a <SyncProvider>");
	}
	return ctx.client;
}
