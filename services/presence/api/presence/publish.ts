/**
 * `POST /api/presence/publish` — set this client's state on one channel.
 *
 * Stateless: it needs no open stream and no prior handshake, which is what
 * lets it land on any instance the platform picks.
 */

import { parsePublishRequest } from "../../protocol.js";
import { cors, json, readJson, type NodeRequest, type NodeResponse } from "../../http.js";
import { getService } from "../../runtime.js";

export default async function handler(request: NodeRequest, response: NodeResponse): Promise<void> {
	if (cors(request, response)) return;
	if (request.method !== "POST") return json(response, 405, { error: "use POST" });

	const parsed = parsePublishRequest(await readJson(request));
	if (!parsed.ok) return json(response, 400, { error: parsed.reason });

	const result = await getService().publish(parsed.value);
	if (!result.ok)
		return json(response, result.status, { error: result.message, code: result.code });
	// No body: the client has nothing to do with a successful publish, and a
	// cursor sends these many times a second.
	response.statusCode = 204;
	response.end();
}
