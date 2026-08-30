// Pure request routing for the htmx adapter. Nothing here touches the DOM or
// htmx itself, so the whole `reflect:` protocol is unit-testable in Bun's
// DOM-less test runner — the glue in `sync.ts` stays thin on purpose.

// ── The `reflect:` URL scheme ──────────────────────────────────────────

export const REFLECT_SCHEME = "reflect:";

export interface ReflectAction {
	table: string;
	rowId?: string;
	params: URLSearchParams;
}

/**
 * Parse a `reflect:<table>[/<rowId>][?<params>]` action.
 *
 * Returns null for anything that is not a reflect action, which is how the
 * fetch shim decides whether to handle a request or let htmx hit the network.
 *
 * htmx rewrites GET/DELETE actions through `new URL(action, document.baseURI)`
 * before the fetch runs. `reflect:` is a non-special scheme, so the URL parser
 * keeps an opaque path and `href` round-trips unchanged (`reflect:todos` stays
 * `reflect:todos`, query params land as `reflect:todos?a=b`). Parsing the raw
 * string rather than going through `URL` keeps both spellings working.
 */
export function parseReflectAction(action: string): ReflectAction | null {
	if (!action.startsWith(REFLECT_SCHEME)) return null;

	const rest = action.slice(REFLECT_SCHEME.length);
	const queryAt = rest.indexOf("?");
	const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
	const query = queryAt === -1 ? "" : rest.slice(queryAt + 1);

	const segments = path.split("/").filter((s) => s.length > 0);
	if (segments.length === 0 || segments.length > 2) return null;

	const table = safeDecode(segments[0] as string);
	if (!table) return null;

	const rawRowId = segments[1];
	const rowId = rawRowId === undefined ? undefined : safeDecode(rawRowId);
	// `reflect:todos/` is a collection read, but `reflect:todos/%` is a typo we
	// should not silently turn into one.
	if (rawRowId !== undefined && !rowId) return null;

	return { table, rowId, params: new URLSearchParams(query) };
}

function safeDecode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return "";
	}
}

// ── Operations ─────────────────────────────────────────────────────────

export type ReflectOperation =
	| { kind: "read"; table: string; rowId?: string; params: URLSearchParams }
	| { kind: "insert"; table: string; rowId: string; payload: Record<string, unknown> }
	| { kind: "update"; table: string; rowId: string; payload: Record<string, unknown> }
	| { kind: "remove"; table: string; rowId: string }
	| { kind: "error"; status: number; message: string };

/** Anything htmx hands us as a request body: URLSearchParams or FormData. */
export type ReflectBody = Iterable<[string, FormDataEntryValue]> | null | undefined;

export interface ResolveOptions {
	/** Used as the row id for POSTs that do not carry one. Injected for tests. */
	generateRowId?: () => string;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Map an action + HTTP method + form body onto a store operation.
 *
 * The mapping is deliberately REST-shaped so the attributes read like ordinary
 * htmx: `hx-get` reads, `hx-post` inserts, `hx-put`/`hx-patch` update,
 * `hx-delete` removes.
 */
export function resolveOperation(
	action: string,
	method: string,
	body?: ReflectBody,
	options: ResolveOptions = {},
): ReflectOperation | null {
	const parsed = parseReflectAction(action);
	if (!parsed) return null;

	const verb = method.toUpperCase();
	const { table, rowId, params } = parsed;

	if (verb === "GET") {
		return { kind: "read", table, rowId, params };
	}

	if (!WRITE_METHODS.has(verb)) {
		return { kind: "error", status: 405, message: `${verb} is not supported by reflect: actions` };
	}

	if (verb === "DELETE") {
		if (!rowId) {
			return {
				kind: "error",
				status: 400,
				message: `DELETE needs a row id: reflect:${table}/<rowId>`,
			};
		}
		return { kind: "remove", table, rowId };
	}

	const payload = collectPayload(body);

	if (verb === "POST") {
		// A POST names the collection; the row id comes from the body when the
		// caller wants a stable one (an `hx-vals` id, a hidden input), otherwise
		// we mint it. Posting to a row URL is a mistake worth reporting.
		if (rowId) {
			return {
				kind: "error",
				status: 400,
				message: `POST targets the collection: reflect:${table}, not reflect:${table}/${rowId}`,
			};
		}
		const bodyRowId = typeof payload.id === "string" && payload.id ? payload.id : undefined;
		const generated = options.generateRowId?.() ?? crypto.randomUUID();
		// An `id` that named the row is consumed, not stored. The store
		// materializes the primary key from the row id already, so leaving it in
		// would be a duplicate on the default `id` pk — and a stray data column
		// on a table whose pk is named anything else.
		if (bodyRowId !== undefined) delete payload.id;
		return { kind: "insert", table, rowId: bodyRowId ?? generated, payload };
	}

	if (!rowId) {
		return {
			kind: "error",
			status: 400,
			message: `${verb} needs a row id: reflect:${table}/<rowId>`,
		};
	}
	return { kind: "update", table, rowId, payload };
}

/**
 * Flatten a form body into a payload.
 *
 * Repeated keys collapse into an array so `<select multiple>` and checkbox
 * groups survive. File entries are dropped: a File cannot cross the op log.
 */
export function collectPayload(body: ReflectBody): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	if (!body) return payload;

	for (const [key, value] of body) {
		if (typeof value !== "string") continue;
		const existing = payload[key];
		if (existing === undefined) {
			payload[key] = value;
		} else if (Array.isArray(existing)) {
			existing.push(value);
		} else {
			payload[key] = [existing, value];
		}
	}
	return payload;
}
