import {
	createPresenceService,
	type PresenceService,
	type StreamSink,
} from "../../services/presence/service.ts";
import { createStaticRegistry, type SeedDefinition } from "../../services/presence/projects.ts";
import { createMemoryStore, type PresenceStore } from "../../services/presence/store.ts";
import type { ServerFrame } from "../../services/presence/protocol.ts";

/**
 * A sink that records every frame written to it.
 *
 * The service writes SSE text, so this parses the `data:` lines back into
 * frames — a test should assert on what the client will see, not on the
 * framing that carries it.
 */
export function createFakeSink(): StreamSink & {
	frames: ServerFrame[];
	chunks: string[];
	closed: boolean;
	framesOfType<T extends ServerFrame["type"]>(type: T): Extract<ServerFrame, { type: T }>[];
	last<T extends ServerFrame["type"]>(type: T): Extract<ServerFrame, { type: T }> | undefined;
} {
	const frames: ServerFrame[] = [];
	const chunks: string[] = [];
	const sink = {
		frames,
		chunks,
		closed: false,
		write(chunk: string) {
			chunks.push(chunk);
			for (const line of chunk.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				frames.push(JSON.parse(line.slice(6)) as ServerFrame);
			}
		},
		close() {
			sink.closed = true;
		},
		framesOfType<T extends ServerFrame["type"]>(type: T) {
			return frames.filter((frame) => frame.type === type) as Extract<ServerFrame, { type: T }>[];
		},
		last<T extends ServerFrame["type"]>(type: T) {
			const matching = sink.framesOfType(type);
			return matching[matching.length - 1];
		},
	};
	return sink;
}

export interface Harness {
	service: PresenceService;
	store: PresenceStore;
}

export interface HarnessOptions {
	seed?: Record<string, SeedDefinition>;
	store?: PresenceStore;
	streamMs?: number;
	fastPollMs?: number;
	idlePollMs?: number;
	now?: () => number;
}

/**
 * Default seed.
 *
 * `maxMessagesPerSecond` is deliberately high: the store enforces the limit as
 * a minimum gap between writes, so at the production default of 30/s two
 * publishes in the same tick of a test would be refused for reasons the test
 * is not about. The rate limit has its own project below.
 */
export const SEED: Record<string, SeedDefinition> = {
	"key-live": { projectId: "proj-1", maxMessagesPerSecond: 1000 },
	"key-other": { projectId: "proj-2", maxMessagesPerSecond: 1000 },
	"key-slow": { projectId: "proj-slow", maxMessagesPerSecond: 1 },
	"key-tiny": {
		projectId: "proj-tiny",
		maxConnections: 1,
		maxEntriesPerRoom: 1,
		maxMessagesPerSecond: 1000,
	},
};

export function setup(options: HarnessOptions = {}): Harness {
	const store = options.store ?? createMemoryStore(options.now);
	const seed = options.seed ?? SEED;
	const service = createPresenceService({
		store,
		registry: createStaticRegistry(seed, store),
		// Short enough that a test does not wait on a poll, long enough that
		// several polls still happen inside one `settle`.
		fastPollMs: options.fastPollMs ?? 5,
		idlePollMs: options.idlePollMs ?? 5,
		streamMs: options.streamMs ?? 60_000,
		keepaliveMs: 60_000,
		now: options.now,
	});
	return { service, store };
}

/** Open a stream and wait for its opening frames. */
export async function open(
	harness: Harness,
	apiKey: string,
	room: string,
	clientId: string,
): Promise<ReturnType<typeof createFakeSink>> {
	const sink = createFakeSink();
	await harness.service.openStream({ apiKey, room, clientId }, sink);
	return sink;
}

export function publish(
	harness: Harness,
	apiKey: string,
	room: string,
	clientId: string,
	channel: string,
	data: Record<string, unknown>,
	extra: { identity?: Record<string, unknown>; ttlMs?: number } = {},
) {
	return harness.service.publish({ apiKey, room, clientId, channel, data, ...extra });
}

export async function settle(ms = 25): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
