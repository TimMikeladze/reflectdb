/**
 * ICE server providers for `server.iceServers()` — STUN/TURN for WebRTC peer
 * meshes. Nothing here is required or hardcoded: pick one, compose them, or
 * pass any function of the `IceServerProvider` shape.
 *
 * ```ts
 * import { cloudflareTurn } from "reflectdb/server/turn";
 *
 * server.iceServers(
 *   cloudflareTurn({
 *     keyId: process.env.CLOUDFLARE_TURN_KEY_ID!,
 *     apiToken: process.env.CLOUDFLARE_TURN_API_TOKEN!,
 *   }),
 * );
 * ```
 *
 * TURN credentials are minted per request and expire. The long-lived secret
 * (a Cloudflare API token, a coturn shared secret) stays on the server.
 */

import type { AuthContext, IceServer } from "../core/types.ts";
import type { IceServerProvider, IceServersResult } from "./types.ts";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** A fixed list — STUN only, or TURN with credentials that never rotate. */
export function staticIceServers(iceServers: IceServer[]): IceServerProvider {
	const result: IceServersResult = { iceServers };
	return () => result;
}

export interface CloudflareTurnConfig {
	/** The TURN key's id, from the Cloudflare dashboard (Realtime → TURN). */
	keyId: string;
	/** The TURN key's API token. A long-lived secret: keep it server-side. */
	apiToken: string;
	/** Lifetime of each generated credential. Default: 24h. */
	ttlSeconds?: number;
	/** Fetch override, for tests or a proxy. Default: globalThis.fetch. */
	fetch?: typeof fetch;
}

/**
 * Cloudflare Realtime TURN. One credential is generated and shared until half
 * its lifetime has passed, so a busy server makes one API call per half-TTL
 * rather than one per client; a client always receives at least half a TTL of
 * validity. Concurrent requests during a refresh share the one API call.
 */
export function cloudflareTurn(config: CloudflareTurnConfig): IceServerProvider {
	const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
	const fetchImpl = config.fetch ?? globalThis.fetch;
	const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`;
	let cached: { result: IceServersResult; refreshAt: number; expiresAt: number } | null = null;
	let inflight: Promise<IceServersResult> | null = null;

	async function generate(): Promise<IceServersResult> {
		const response = await fetchImpl(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ttl: ttlSeconds }),
		});
		if (!response.ok) {
			// The body can echo request details; the status is enough to act on.
			throw new Error(`Cloudflare TURN credential request failed: HTTP ${response.status}`);
		}
		const body = (await response.json()) as { iceServers?: unknown };
		const iceServers = withoutBlockedPorts(normalize(body.iceServers));
		if (iceServers.length === 0) throw new Error("Cloudflare TURN returned no ICE servers");
		const now = Date.now();
		cached = {
			result: { iceServers, ttlSeconds },
			refreshAt: now + (ttlSeconds * 1000) / 2,
			expiresAt: now + ttlSeconds * 1000,
		};
		return cached.result;
	}

	return () => {
		const now = Date.now();
		if (cached && now < cached.refreshAt) {
			// Report the time left, not the full TTL: the credential is shared.
			return {
				iceServers: cached.result.iceServers,
				ttlSeconds: Math.floor((cached.expiresAt - now) / 1000),
			};
		}
		inflight ??= generate().finally(() => {
			inflight = null;
		});
		return inflight;
	};
}

export interface SharedSecretTurnConfig {
	/** TURN URLs, e.g. `["turn:turn.example.com:3478", "turns:turn.example.com:5349"]`. */
	urls: string[];
	/** The server's shared secret (coturn `static-auth-secret`). */
	secret: string;
	/** Lifetime of each credential. Default: 24h. */
	ttlSeconds?: number;
	/** STUN servers to list alongside. Default: none. */
	stun?: string[];
}

/**
 * The TURN REST-API credential scheme (coturn's `use-auth-secret`, and most
 * self-hosted TURN servers): username `expiry:userId`, password the base64
 * HMAC-SHA1 of the username under the shared secret. Computed locally — no
 * network call — and bound to the authenticated user.
 */
export function sharedSecretTurn<TAuth extends AuthContext = AuthContext>(
	config: SharedSecretTurnConfig,
): IceServerProvider<TAuth> {
	const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
	const encoder = new TextEncoder();
	const key = crypto.subtle.importKey(
		"raw",
		encoder.encode(config.secret),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);

	return async ({ auth }) => {
		const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
		// A colon would end the user part early in the server's parser.
		const username = `${expiry}:${String(auth.userId).replaceAll(":", "_")}`;
		const signature = await crypto.subtle.sign("HMAC", await key, encoder.encode(username));
		const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
		const iceServers: IceServer[] = [{ urls: config.urls, username, credential }];
		if (config.stun?.length) iceServers.unshift({ urls: config.stun });
		return { iceServers, ttlSeconds };
	};
}

function normalize(value: unknown): IceServer[] {
	// Older responses carried a single object rather than an array.
	const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
	const out: IceServer[] = [];
	for (const entry of list) {
		const server = entry as Partial<IceServer>;
		if (typeof server.urls !== "string" && !Array.isArray(server.urls)) continue;
		out.push({
			urls: server.urls,
			...(typeof server.username === "string" ? { username: server.username } : {}),
			...(typeof server.credential === "string" ? { credential: server.credential } : {}),
		});
	}
	return out;
}

/** Browsers block port 53; a URL using it only times out, so it is dropped. */
function withoutBlockedPorts(servers: IceServer[]): IceServer[] {
	const blocked = (url: string) => /:53(\?|$)/.test(url);
	const out: IceServer[] = [];
	for (const server of servers) {
		const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
			(url) => !blocked(url),
		);
		if (urls.length > 0) out.push({ ...server, urls });
	}
	return out;
}
