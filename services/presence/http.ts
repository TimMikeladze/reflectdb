/**
 * Node HTTP glue shared by every handler under `api/`.
 *
 * The handlers themselves stay a dozen lines each: parse, call the service,
 * map the result to a status. Everything that is about HTTP rather than about
 * presence lives here.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { allowedOrigin } from "./runtime.js";

export type NodeRequest = IncomingMessage & { body?: unknown; query?: Record<string, unknown> };
export type NodeResponse = ServerResponse;

/** Largest body accepted, in bytes. Presence payloads are small by design. */
const MAX_BODY_BYTES = 32 * 1024;

/**
 * Apply CORS, and answer a preflight.
 *
 * Returns true when the request is finished and the handler should stop — a
 * preflight, or an origin that is not on the list.
 */
export function cors(request: NodeRequest, response: NodeResponse): boolean {
	const origin = Array.isArray(request.headers.origin)
		? request.headers.origin[0]
		: request.headers.origin;
	const allowed = allowedOrigin(origin);

	if (!allowed) {
		response.statusCode = 403;
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ error: "origin not allowed" }));
		return true;
	}

	response.setHeader("Access-Control-Allow-Origin", allowed);
	if (allowed !== "*") response.setHeader("Vary", "Origin");

	if (request.method === "OPTIONS") {
		response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		response.setHeader("Access-Control-Allow-Headers", "Content-Type");
		response.setHeader("Access-Control-Max-Age", "86400");
		response.statusCode = 204;
		response.end();
		return true;
	}
	return false;
}

/**
 * Read one JSON body, whatever the platform already did to it.
 *
 * Three shapes reach here. Vercel parses `application/json` into an object;
 * `navigator.sendBeacon` posts `text/plain`, which arrives as a string; and a
 * plain Node server leaves the stream untouched. A leave beacon is the one
 * send that survives a page closing, so refusing its content type would mean
 * losing exactly the message that matters most.
 */
export async function readJson(request: NodeRequest): Promise<unknown> {
	if (request.body !== undefined && request.body !== null) {
		if (typeof request.body === "string") {
			try {
				return JSON.parse(request.body);
			} catch {
				return null;
			}
		}
		return request.body;
	}

	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) return null;
		chunks.push(buffer);
	}
	if (chunks.length === 0) return null;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
}

export function json(response: NodeResponse, status: number, body: unknown): void {
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json");
	response.setHeader("Cache-Control", "no-store");
	response.end(JSON.stringify(body));
}

/** The query string, whether or not the platform pre-parsed it. */
export function queryOf(request: NodeRequest): URLSearchParams {
	const url = new URL(request.url ?? "/", "http://presence.local");
	return url.searchParams;
}

/**
 * Put the response into SSE mode.
 *
 * `X-Accel-Buffering: no` is not decoration: a proxy that buffers the response
 * turns a live stream into one long download that arrives when it ends, which
 * looks exactly like a presence service that never sends anything.
 */
export function openSse(response: NodeResponse): void {
	response.statusCode = 200;
	response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	response.setHeader("Cache-Control", "no-cache, no-transform");
	response.setHeader("Connection", "keep-alive");
	response.setHeader("X-Accel-Buffering", "no");
	response.flushHeaders?.();
}
