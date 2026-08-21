/**
 * Local server for the presence service — `bun services/presence/dev.ts`.
 *
 * Serves exactly the routes Vercel serves, through exactly the same handlers,
 * on `node:http` rather than a framework. Nothing about the service is
 * simulated here: the difference between this and production is one process
 * instead of many, which is the one difference the polling design was chosen
 * to make invisible.
 *
 * `PRESENCE_STORE=memory` runs it with no database at all.
 */

import { createServer } from "node:http";
import health from "./api/health.js";
import leave from "./api/presence/leave.js";
import publish from "./api/presence/publish.js";
import stream from "./api/presence/stream.js";
import type { NodeRequest, NodeResponse } from "./http.js";

const PORT = Number(process.env.PORT ?? 8080);

type Handler = (request: NodeRequest, response: NodeResponse) => Promise<void>;

const routes: Record<string, Handler> = {
	"/api/health": health,
	"/api/presence/stream": stream,
	"/api/presence/publish": publish,
	"/api/presence/leave": leave,
};

const server = createServer((request, response) => {
	const path = new URL(request.url ?? "/", "http://presence.local").pathname;

	if (path === "/") {
		response.setHeader("Content-Type", "application/json");
		response.end(
			JSON.stringify({
				service: "reflectdb-presence",
				base: `http://localhost:${PORT}/api/presence`,
			}),
		);
		return;
	}

	const handler = routes[path];
	if (!handler) {
		response.statusCode = 404;
		response.end("not found");
		return;
	}

	void handler(request as NodeRequest, response).catch((err: unknown) => {
		console.error(`[presence] ${path} failed:`, err);
		if (response.headersSent) {
			response.end();
			return;
		}
		response.statusCode = 500;
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ error: "internal error" }));
	});
});

// A stream lives for its full recycle window, so the default 2-minute socket
// timeout would cut every one of them short.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(PORT, () => {
	const store = process.env.PRESENCE_STORE === "memory" ? "memory" : "postgres";
	console.log(`[presence] listening on :${PORT} — store=${store}`);
	console.log(`[presence] point a client at http://localhost:${PORT}/api/presence`);
});

function shutdown(signal: string): void {
	console.log(`[presence] ${signal} — draining`);
	server.close(() => process.exit(0));
	// A stream that is mid-recycle should not hold the process open for a
	// minute; presence state is disposable and clients republish on reconnect.
	server.closeAllConnections?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
