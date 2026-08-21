/**
 * `GET /api/health` — is the database reachable, and what is this instance
 * holding?
 *
 * Metrics are per-instance and always will be: there is no fleet-wide view to
 * report from a function that knows only itself. Two calls in a row can land
 * on different instances and disagree, which is information rather than a
 * defect — it says the platform is running more than one.
 */

import { cors, json, type NodeRequest, type NodeResponse } from "../http.js";
import { getService, getStore } from "../runtime.js";

export default async function handler(request: NodeRequest, response: NodeResponse): Promise<void> {
	if (cors(request, response)) return;

	try {
		// Any store read that touches the backend will do; `countClients` on a
		// project nobody uses is the cheapest one that proves a round trip.
		await getStore().countClients("__health__");
	} catch (err) {
		return json(response, 503, {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	json(response, 200, { ok: true, ...getService().metrics() });
}
