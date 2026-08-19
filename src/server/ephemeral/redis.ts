/**
 * Redis-backed ephemeral adapter — shared presence state plus a cross-instance bus.
 *
 * Solves the two things the in-process adapter cannot: a client that joins sees
 * peers who arrived before it (shared state), and clients on different
 * instances see each other at all (pub/sub bus).
 *
 * Layout, under `prefix` (default `reflectdb:eph`):
 *
 *   {p}:s:{room}:{key}  HASH   clientId -> JSON(EphemeralState)
 *   {p}:rk:{room}       SET    channel keys present in the room
 *   {p}:c:{clientId}    SET    packed "room\0key\0clientId" a client owns
 *   {p}:exp            ZSET    packed entry -> expiry deadline (ms)
 *   {p}:n            STRING    entry counter, for the capacity gate
 *   {p}:bus         CHANNEL    EphemeralBroadcast, JSON
 *
 * Writes go through Lua so the hash, the indexes and the counter move together
 * — presence is the highest-frequency message in the protocol, and a
 * non-atomic multi-command write both costs extra round trips and lets the
 * counter drift away from reality under concurrency.
 */

import type { EphemeralAdapter, EphemeralBroadcast, EphemeralState } from "./types.ts";

/**
 * Minimal Redis client interface — one raw-command entrypoint.
 *
 * Compatible with ioredis (`client.call`) directly. For node-redis, wrap it:
 *
 * ```ts
 * const shim = { call: (cmd, ...args) => client.sendCommand([cmd, ...args.map(String)]) };
 * ```
 */
export interface RedisLike {
	call(command: string, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Pub/sub seam — one function, because no two Redis clients agree on the shape
 * of theirs (argument order, `on("message")` vs a per-channel listener). Wire
 * yours in a two-line shim rather than have this module guess:
 *
 * ```ts
 * // ioredis (separate connection — subscribe mode blocks other commands)
 * { subscribe: (ch, onMessage) => {
 *     sub.on("message", (c, m) => { if (c === ch) onMessage(m); });
 *     return sub.subscribe(ch);
 *   } }
 *
 * // Bun
 * { subscribe: (ch, onMessage) => sub.subscribe(ch, (msg) => onMessage(msg)) }
 * ```
 */
export interface RedisSubscriberLike {
	subscribe(channel: string, onMessage: (payload: string) => void): Promise<unknown> | unknown;
}

export interface RedisEphemeralConfig {
	/** Command connection. */
	client: RedisLike;
	/**
	 * Separate connection used for pub/sub. Omit to run shared-state-only —
	 * peers then see each other's presence on join and on sweep, but not live.
	 */
	subscriber?: RedisSubscriberLike;
	/** Key prefix. Default: "reflectdb:eph" */
	prefix?: string;
	/** Global entry ceiling across the fleet. Default: 100_000 */
	maxEntries?: number;
	/**
	 * Safety-net expiry on state hashes, in seconds. Guards against a crashed
	 * instance leaving entries behind when its clients never disconnect
	 * cleanly. Default: 86400 (24h), matching the handler's TTL clamp.
	 */
	hashTtlSeconds?: number;
}

const DEFAULT_PREFIX = "reflectdb:eph";
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_HASH_TTL_SECONDS = 24 * 60 * 60;

/** Entries removed per expiry sweep. Bounds the work one tick can do. */
const SWEEP_BATCH = 1_000;

function packed(room: string, key: string, clientId: string): string {
	return `${room}\x00${key}\x00${clientId}`;
}

function unpack(value: string): { room: string; key: string; clientId: string } {
	const [room, key, clientId] = value.split("\x00");
	return { room: room!, key: key!, clientId: clientId! };
}

/**
 * Hash replies come back either as a flat [field, value, ...] array (ioredis,
 * node-redis on RESP2) or already decoded into an object (Bun, RESP3 maps).
 * Both are valid; normalize rather than require one client family.
 */
function hashEntries(reply: unknown): Array<[string, string]> {
	if (Array.isArray(reply)) {
		const out: Array<[string, string]> = [];
		for (let i = 0; i + 1 < reply.length; i += 2) {
			out.push([String(reply[i]), String(reply[i + 1])]);
		}
		return out;
	}
	if (reply && typeof reply === "object") {
		return Object.entries(reply as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
	}
	return [];
}

function toStringArray(reply: unknown): string[] {
	return Array.isArray(reply) ? reply.map((v) => String(v)) : [];
}

/**
 * SET: write the entry, index it, and bump the counter only when the field is
 * new. Reports full, without writing, when a new entry would cross the ceiling.
 *
 * KEYS[1] state hash   KEYS[2] room-keys set   KEYS[3] client set
 * KEYS[4] expiry zset  KEYS[5] counter
 * ARGV[1] clientId  [2] json  [3] packed  [4] key  [5] expiresAt ("" = none)
 * [6] maxEntries  [7] hashTtlSeconds
 */
const SET_SCRIPT = `
local isNew = 0
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
  local count = tonumber(redis.call('GET', KEYS[5]) or '0')
  if count >= tonumber(ARGV[6]) then return 0 end
  isNew = 1
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[7])
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[7])
redis.call('SADD', KEYS[3], ARGV[3])
redis.call('EXPIRE', KEYS[3], ARGV[7])
if ARGV[5] ~= '' then
  redis.call('ZADD', KEYS[4], ARGV[5], ARGV[3])
else
  redis.call('ZREM', KEYS[4], ARGV[3])
end
if isNew == 1 then redis.call('INCR', KEYS[5]) end
return 1
`;

/**
 * REMOVE: drop the entry and every index that pointed at it.
 *
 * KEYS[1] state hash   KEYS[2] room-keys set   KEYS[3] expiry zset
 * KEYS[4] counter      KEYS[5] client set
 * ARGV[1] clientId  [2] packed  [3] key
 */
const REMOVE_SCRIPT = `
if redis.call('HDEL', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('ZREM', KEYS[3], ARGV[2])
redis.call('SREM', KEYS[5], ARGV[2])
if redis.call('HLEN', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[2], ARGV[3])
end
local count = tonumber(redis.call('GET', KEYS[4]) or '0')
if count > 0 then redis.call('DECR', KEYS[4]) end
return 1
`;

export function createRedisEphemeral(
	config: RedisEphemeralConfig,
): EphemeralAdapter & { ready(): Promise<void> } {
	const client = config.client;
	const p = config.prefix ?? DEFAULT_PREFIX;
	const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const hashTtl = config.hashTtlSeconds ?? DEFAULT_HASH_TTL_SECONDS;

	const stateKey = (room: string, key: string) => `${p}:s:${room}:${key}`;
	const roomKeysKey = (room: string) => `${p}:rk:${room}`;
	const clientKey = (clientId: string) => `${p}:c:${clientId}`;
	const expKey = `${p}:exp`;
	const countKey = `${p}:n`;
	const busChannel = `${p}:bus`;

	let readyPromise: Promise<void> | null = null;
	let onEventCallback: ((event: EphemeralBroadcast) => void) | null = null;

	function parseState(raw: string): EphemeralState | null {
		try {
			return JSON.parse(raw) as EphemeralState;
		} catch {
			return null;
		}
	}

	/** Entries are swept on a timer, but a read must not surface a stale one. */
	function isLive(state: EphemeralState, now: number): boolean {
		return !state.ttlMs || now - state.updatedAt <= state.ttlMs;
	}

	async function removeEntry(room: string, key: string, clientId: string): Promise<void> {
		await client.call(
			"EVAL",
			REMOVE_SCRIPT,
			5,
			stateKey(room, key),
			roomKeysKey(room),
			expKey,
			countKey,
			clientKey(clientId),
			clientId,
			packed(room, key, clientId),
			key,
		);
	}

	/** Resolves once the bus subscription is live. Idempotent. */
	async function ready(): Promise<void> {
		if (readyPromise) return readyPromise;
		const subscriber = config.subscriber;
		if (!subscriber) return;
		readyPromise = (async () => {
			await subscriber.subscribe(busChannel, (payload) => {
				if (!onEventCallback) return;
				try {
					onEventCallback(JSON.parse(payload) as EphemeralBroadcast);
				} catch {
					// A malformed frame must not take the bus listener down.
				}
			});
		})();
		return readyPromise;
	}

	return {
		ready,

		async set(room, key, clientId, userId, data, ttlMs): Promise<boolean> {
			const now = Date.now();
			const state: EphemeralState = {
				clientId,
				userId,
				key,
				data,
				updatedAt: now,
				ttlMs,
			};
			const entry = packed(room, key, clientId);
			const result = await client.call(
				"EVAL",
				SET_SCRIPT,
				5,
				stateKey(room, key),
				roomKeysKey(room),
				clientKey(clientId),
				expKey,
				countKey,
				clientId,
				JSON.stringify(state),
				entry,
				key,
				ttlMs ? String(now + ttlMs) : "",
				String(maxEntries),
				String(hashTtl),
			);
			return Number(result) === 1;
		},

		async get(room, key): Promise<Record<string, EphemeralState>> {
			const reply = await client.call("HGETALL", stateKey(room, key));
			const now = Date.now();
			const out: Record<string, EphemeralState> = {};
			for (const [entryClientId, raw] of hashEntries(reply)) {
				const state = parseState(raw);
				if (state && isLive(state, now)) out[entryClientId] = state;
			}
			return out;
		},

		async getRoom(room): Promise<Record<string, Record<string, EphemeralState>>> {
			const keys = toStringArray(await client.call("SMEMBERS", roomKeysKey(room)));
			const now = Date.now();
			const out: Record<string, Record<string, EphemeralState>> = {};
			for (const key of keys) {
				const reply = await client.call("HGETALL", stateKey(room, key));
				const channel: Record<string, EphemeralState> = {};
				for (const [entryClientId, raw] of hashEntries(reply)) {
					const state = parseState(raw);
					if (state && isLive(state, now)) channel[entryClientId] = state;
				}
				if (Object.keys(channel).length > 0) out[key] = channel;
			}
			return out;
		},

		async remove(room, key, clientId): Promise<void> {
			await removeEntry(room, key, clientId);
		},

		async removeClient(clientId): Promise<void> {
			const entries = toStringArray(await client.call("SMEMBERS", clientKey(clientId)));
			for (const value of entries) {
				const { room, key, clientId: owner } = unpack(value);
				await removeEntry(room, key, owner);
			}
			await client.call("DEL", clientKey(clientId));
		},

		async cleanupExpired(): Promise<void> {
			// The zset holds deadlines, so expiry is a range read rather than a
			// scan of every entry in the fleet.
			const due = toStringArray(
				await client.call(
					"ZRANGEBYSCORE",
					expKey,
					"-inf",
					String(Date.now()),
					"LIMIT",
					0,
					SWEEP_BATCH,
				),
			);
			for (const value of due) {
				const { room, key, clientId } = unpack(value);
				await removeEntry(room, key, clientId);
			}
		},

		async size(): Promise<number> {
			const reply = await client.call("GET", countKey);
			return reply == null ? 0 : Number(reply);
		},

		async destroy(): Promise<void> {
			// Shared state outlives this process — dropping it here would wipe
			// presence for every other instance. Only the local listener goes.
			onEventCallback = null;
		},

		async publish(event): Promise<void> {
			await client.call("PUBLISH", busChannel, JSON.stringify(event));
		},

		async subscribe(onEvent): Promise<void> {
			onEventCallback = onEvent;
			await ready();
		},
	};
}
