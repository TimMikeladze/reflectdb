import type { RedisLike, RedisSubscriberLike } from "../../src/server/ephemeral/redis.ts";
import type { Connection } from "../../services/presence/service.ts";
import type { ServerFrame } from "../../services/presence/protocol.ts";

/**
 * In-memory stand-in for the handful of Redis commands the registry and bus
 * use. Keeps protocol tests hermetic — the Redis-backed store has its own
 * suite against a real server, and this one is about frames, not Lua.
 */
export function createFakeRedis(): {
	client: RedisLike;
	subscriberFor(): RedisSubscriberLike;
	hashes: Map<string, Map<string, string>>;
	strings: Map<string, string>;
} {
	const hashes = new Map<string, Map<string, string>>();
	const strings = new Map<string, string>();
	const channels = new Map<string, Set<(payload: string) => void>>();

	const client: RedisLike = {
		async call(command: string, ...args: (string | number)[]): Promise<unknown> {
			const cmd = command.toUpperCase();
			const a = args.map(String);
			switch (cmd) {
				case "HSETNX": {
					const hash = hashes.get(a[0]!) ?? new Map<string, string>();
					hashes.set(a[0]!, hash);
					if (hash.has(a[1]!)) return 0;
					hash.set(a[1]!, a[2]!);
					return 1;
				}
				case "HSET": {
					const hash = hashes.get(a[0]!) ?? new Map<string, string>();
					hashes.set(a[0]!, hash);
					const isNew = hash.has(a[1]!) ? 0 : 1;
					hash.set(a[1]!, a[2]!);
					return isNew;
				}
				case "HGETALL": {
					const hash = hashes.get(a[0]!);
					if (!hash) return [];
					return [...hash.entries()].flat();
				}
				case "GET":
					return strings.get(a[0]!) ?? null;
				case "SET":
					strings.set(a[0]!, a[1]!);
					return "OK";
				case "INCR": {
					const next = Number(strings.get(a[0]!) ?? "0") + 1;
					strings.set(a[0]!, String(next));
					return next;
				}
				case "DECR": {
					const next = Number(strings.get(a[0]!) ?? "0") - 1;
					strings.set(a[0]!, String(next));
					return next;
				}
				case "EXPIRE":
					return 1;
				case "DEL":
					strings.delete(a[0]!);
					hashes.delete(a[0]!);
					return 1;
				case "PUBLISH": {
					const subscribers = channels.get(a[0]!);
					if (subscribers) {
						// Deliver asynchronously, like a real bus, so tests catch
						// anything that depends on synchronous delivery.
						for (const listener of subscribers) {
							queueMicrotask(() => listener(a[1]!));
						}
					}
					return subscribers?.size ?? 0;
				}
				default:
					throw new Error(`fake redis: unsupported command ${cmd}`);
			}
		},
	};

	return {
		client,
		hashes,
		strings,
		subscriberFor(): RedisSubscriberLike {
			return {
				subscribe(channel: string, onMessage: (payload: string) => void) {
					const set = channels.get(channel) ?? new Set<(payload: string) => void>();
					set.add(onMessage);
					channels.set(channel, set);
				},
			};
		},
	};
}

/** A connection that records every frame written to it. */
export function createFakeConnection(): Connection & {
	frames: ServerFrame[];
	closed: boolean;
	framesOfType<T extends ServerFrame["type"]>(
		type: T,
	): Extract<ServerFrame, { type: T }>[];
} {
	const frames: ServerFrame[] = [];
	const connection = {
		frames,
		closed: false,
		send(payload: string) {
			frames.push(JSON.parse(payload) as ServerFrame);
		},
		close() {
			connection.closed = true;
		},
		framesOfType<T extends ServerFrame["type"]>(type: T) {
			return frames.filter((f) => f.type === type) as Extract<ServerFrame, { type: T }>[];
		},
	};
	return connection;
}

export async function settle(ms = 5): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}
