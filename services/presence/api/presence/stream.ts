/**
 * `GET /api/presence/stream` — the room, as server-sent events.
 *
 * The invocation lives as long as the stream does, which on a serverless
 * platform is a bounded thing: the service closes it on a schedule and the
 * client reopens. That is why nothing about a client's identity or its
 * published state lives in this request.
 */

import { parseStreamRequest } from "../../protocol.js";
import { closeStream, type StreamSink } from "../../service.js";
import { cors, json, openSse, queryOf, type NodeRequest, type NodeResponse } from "../../http.js";
import { getService } from "../../runtime.js";

export default async function handler(request: NodeRequest, response: NodeResponse): Promise<void> {
	if (cors(request, response)) return;
	if (request.method !== "GET") return json(response, 405, { error: "use GET" });

	const parsed = parseStreamRequest(queryOf(request));
	if (!parsed.ok) return json(response, 400, { error: parsed.reason });

	// Headers go out before the API key is checked, because an `EventSource`
	// cannot read a status code — it reports every non-200 as an anonymous
	// "connection failed" and retries forever. A refusal has to arrive as a
	// frame on a 200 stream, which means committing to the stream first.
	openSse(response);

	const sink: StreamSink = {
		write: (chunk) => {
			response.write(chunk);
		},
		close: () => {
			response.end();
		},
	};

	// The client going away is the only disconnect signal there is; without it
	// the instance would keep polling the room on behalf of a browser that
	// closed the tab minutes ago. Which object emits it depends on the runtime
	// — Node fires it on the response, some others only on the request — so
	// listen on both. `closeStream` is idempotent.
	const disconnected = () => closeStream(sink);
	response.on("close", disconnected);
	request.on("close", disconnected);
	request.on("aborted", disconnected);

	const result = await getService().openStream(parsed.value, sink);
	if (!result.ok) {
		// `openStream` already wrote the error frame and ended the response.
		console.warn(`[presence] stream refused: ${result.code} ${result.message}`);
	}
}
