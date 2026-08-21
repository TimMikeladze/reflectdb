/**
 * `POST /api/presence/leave` — drop one channel, or everything a client holds.
 *
 * This is what makes a cursor vanish when a tab closes rather than linger for
 * a TTL, so it accepts `text/plain`: `navigator.sendBeacon` is the only send
 * that survives a page teardown and it does not let the caller choose a
 * content type.
 */

import { parseLeaveRequest } from "../../protocol.js";
import { cors, json, readJson, type NodeRequest, type NodeResponse } from "../../http.js";
import { getService } from "../../runtime.js";

export default async function handler(request: NodeRequest, response: NodeResponse): Promise<void> {
	if (cors(request, response)) return;
	if (request.method !== "POST") return json(response, 405, { error: "use POST" });

	const parsed = parseLeaveRequest(await readJson(request));
	if (!parsed.ok) return json(response, 400, { error: parsed.reason });

	const result = await getService().leave(parsed.value);
	if (!result.ok)
		return json(response, result.status, { error: result.message, code: result.code });
	response.statusCode = 204;
	response.end();
}
