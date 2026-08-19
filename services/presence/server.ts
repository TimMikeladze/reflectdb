/**
 * Bun HTTP + WebSocket binding for the presence service.
 *
 * Everything protocol-shaped lives in `service.ts`; this file only moves bytes
 * between a socket and that core, and exposes the endpoints Fly needs to route
 * and health-check the app.
 */

import { RedisClient } from "bun";
import { createPresenceService, type PresenceService } from "./service.ts";
import type { Project } from "./projects.ts";
import type { RedisLike, RedisSubscriberLike } from "../../src/server/ephemeral/redis.ts";

const PORT = Number(process.env.PORT ?? 8080);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const PREFIX = process.env.PRESENCE_PREFIX ?? "presence";

/**
 * Fly gives each Machine a stable id; it is the natural instance identity for
 * dropping a bus echo. Falls back to a random id off-platform.
 */
const SERVER_ID =
	process.env.FLY_MACHINE_ID ?? process.env.FLY_ALLOC_ID ?? `local-${crypto.randomUUID().slice(0, 8)}`;

/** Bun takes raw commands as (command, string[]); the adapter uses varargs. */
function callShim(client: RedisClient): RedisLike {
	return {
		call: (command: string, ...args: (string | number)[]) =>
			client.send(command, args.map(String)) as Promise<unknown>,
	};
}

function subscriberShim(client: RedisClient): RedisSubscriberLike {
	return {
		subscribe: (channel: string, onMessage: (payload: string) => void) =>
			client.subscribe(channel, (message: string) => onMessage(message)),
	};
}

function parseSeed(): Record<string, Partial<Project> & { projectId: string }> | undefined {
	const raw = process.env.PRESENCE_PROJECTS;
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Record<string, Partial<Project> & { projectId: string }>;
		for (const [apiKey, definition] of Object.entries(parsed)) {
			if (!definition?.projectId) {
				throw new Error(`seed entry "${apiKey}" is missing projectId`);
			}
		}
		return parsed;
	} catch (err) {
		// Refusing to boot beats booting with no valid keys and rejecting every
		// client with "unknown API key" until somebody reads the logs.
		throw new Error(
			`PRESENCE_PROJECTS is not valid: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

const commands = new RedisClient(REDIS_URL);
const busConnection = new RedisClient(REDIS_URL);
await commands.connect();
await busConnection.connect();

const service: PresenceService = createPresenceService({
	client: callShim(commands),
	subscriber: subscriberShim(busConnection),
	prefix: PREFIX,
	serverId: SERVER_ID,
	seed: parseSeed(),
});

await service.start();

interface SocketData {
	clientId: string;
}

const server = Bun.serve<SocketData, never>({
	port: PORT,
	idleTimeout: 120,

	async fetch(request, srv) {
		const url = new URL(request.url);

		if (url.pathname === "/connect") {
			// The id is minted here and the session opened in `websocket.open`,
			// where there is finally a socket to write frames to.
			const clientId = crypto.randomUUID();
			if (srv.upgrade(request, { data: { clientId } })) return undefined;
			return new Response("expected a websocket upgrade", { status: 426 });
		}

		if (url.pathname === "/health") {
			try {
				await commands.send("PING", []);
			} catch (err) {
				return Response.json(
					{ ok: false, error: err instanceof Error ? err.message : String(err) },
					{ status: 503 },
				);
			}
			return Response.json({ ok: true, serverId: SERVER_ID });
		}

		if (url.pathname === "/metrics") {
			return Response.json(service.metrics());
		}

		if (url.pathname === "/") {
			return Response.json({
				service: "reflectdb-presence",
				serverId: SERVER_ID,
				connect: `wss://${url.host}/connect`,
			});
		}

		return new Response("not found", { status: 404 });
	},

	websocket: {
		open(ws) {
			service.open(ws.data.clientId, {
				send: (payload) => ws.send(payload),
				close: () => ws.close(),
			});
		},
		async message(ws, message) {
			await service.handle(ws.data.clientId, String(message));
		},
		async close(ws) {
			await service.close(ws.data.clientId);
		},
	},
});

console.log(
	`[presence] listening on :${PORT} — serverId=${SERVER_ID} redis=${REDIS_URL.replace(/:[^:@]*@/, ":***@")}`,
);

async function shutdown(signal: string): Promise<void> {
	console.log(`[presence] ${signal} — draining`);
	server.stop();
	await service.shutdown();
	commands.close();
	busConnection.close();
	process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
