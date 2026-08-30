import { createSync } from "../vanilla/sync.ts";
import type { TableBinding, VanillaSync, VanillaSyncConfig } from "../vanilla/sync.ts";
import type { SyncClientState } from "../client/sync-client.ts";
import { parseReflectAction, resolveOperation } from "./router.ts";
import type { ReflectBody } from "./router.ts";

// ── The htmx surface we rely on ────────────────────────────────────────
//
// Structural rather than imported: htmx.org ships no types for 4.x, and
// declaring only what we touch keeps a 4.0.x reshuffle from breaking the build.

/** The request context htmx hands to `htmx:config:request` listeners. */
export interface HtmxRequestContext {
	sourceElement: Element;
	target?: Element;
	swap?: string;
	request: {
		action: string;
		method: string;
		headers: Record<string, string>;
		body?: ReflectBody;
	};
	/**
	 * htmx runs `ctx.fetch ||= window.fetch` after `htmx:config:request`, so a
	 * listener that assigns here owns the response and htmx still performs the
	 * swap, OOB handling, settling and history it normally would.
	 */
	fetch?: (action: string, request: unknown) => Promise<Response>;
}

export interface HtmxLike {
	ajax(verb: string, path: string, options?: Record<string, unknown>): Promise<unknown>;
	/** `metaCharacter` rewrites the `:` in htmx's own event names when set. */
	config?: { metaCharacter?: string };
}

// ── Views ──────────────────────────────────────────────────────────────

export interface ReflectViewInput<T> {
	/** Every row for a collection read; the single row (or none) for a row read. */
	rows: T[];
	table: string;
	/** Set when the action addressed one row: `reflect:todos/abc`. */
	rowId?: string;
	/** Query string of the action, for filtering and sorting inside the view. */
	params: URLSearchParams;
}

/** Renders local rows to the HTML fragment htmx will swap in. */
export type ReflectView<T = Record<string, unknown>> = (input: ReflectViewInput<T>) => string;

/** Coerces a form body before it reaches the op log (checkboxes, numbers, …). */
export type ReflectParse<T = Record<string, unknown>> = (
	payload: Record<string, unknown>,
) => Partial<T>;

// ── Config ─────────────────────────────────────────────────────────────

export interface HtmxSyncConfig extends VanillaSyncConfig {
	/** The htmx instance to attach to — import it yourself and pass it in. */
	htmx: HtmxLike;
}

export interface HtmxSync {
	/** The underlying vanilla sync, for anything the attributes cannot express. */
	sync: VanillaSync;

	/** Register the renderer for a table. Required before any read of it. */
	view<T extends object = Record<string, unknown>>(table: string, view: ReflectView<T>): HtmxSync;
	/** Register an optional payload coercion for writes to a table. */
	parse<T extends object = Record<string, unknown>>(
		table: string,
		parse: ReflectParse<T>,
	): HtmxSync;

	/** Attach the `reflect:` fetch shim to htmx. Idempotent. */
	install(): HtmxSync;
	/** Detach the shim and drop every element binding. */
	uninstall(): void;

	/** Re-render bound elements now — one table, or all of them. */
	refresh(table?: string): void;

	connect(): Promise<void>;
	close(): Promise<void>;
	getState(): SyncClientState;
	onStateChange(cb: (state: SyncClientState) => void): () => void;
	getPendingCount(): number;
	onPendingChange(cb: (count: number) => void): () => void;
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

// ── Factory ────────────────────────────────────────────────────────────

export function createHtmxSync(config: HtmxSyncConfig): HtmxSync {
	const { htmx, ...syncConfig } = config;
	const sync = createSync(syncConfig);
	// htmx renames the `:` in its event names when `config.metaCharacter` is set,
	// so the name is resolved from the instance rather than hardcoded.
	const configRequestEvent = "htmx:config:request".replace(
		/:/g,
		htmx.config?.metaCharacter || ":",
	);

	const views = new Map<string, ReflectView<never>>();
	const parsers = new Map<string, ReflectParse<never>>();
	const bindings = new Map<string, TableBinding>();
	const unsubscribes = new Map<string, () => void>();

	// Keyed by the element the response was swapped INTO, not by the element that
	// asked. A list bound to `reflect:todos` and a filter button aimed at that
	// same list with `reflect:todos?filter=open` are two sources for one target;
	// keying by target means the most recent read wins and re-renders alone,
	// instead of the two fighting over the element on every change.
	interface Binding {
		table: string;
		action: string;
		source: Element;
		target: Element;
		swap?: string;
	}
	const bound = new Map<Element, Binding>();

	const dirty = new Set<string>();
	let flushHandle: ReturnType<typeof setTimeout> | null = null;
	let installed = false;
	let closed = false;

	// ── Table bindings ─────────────────────────────────────────────────

	function bindingFor(table: string): TableBinding {
		let binding = bindings.get(table);
		if (!binding) {
			binding = sync.sync(table);
			bindings.set(table, binding);
			unsubscribes.set(
				table,
				binding.onChange(() => {
					scheduleRender(table);
				}),
			);
		}
		return binding;
	}

	// ── Re-render scheduling ───────────────────────────────────────────

	function scheduleRender(table: string): void {
		if (closed) return;
		dirty.add(table);
		if (flushHandle !== null) return;
		// A macrotask, not a microtask: a burst of ops arriving in one server
		// message — or an optimistic write still inside its own `serve` call —
		// coalesces into a single re-render per table, after htmx has finished
		// settling the request that caused it.
		flushHandle = setTimeout(() => {
			flushHandle = null;
			const tables = [...dirty];
			dirty.clear();
			for (const t of tables) renderTable(t);
		}, 0);
	}

	function renderTable(table: string): void {
		for (const [target, entry] of bound) {
			if (!target.isConnected) {
				bound.delete(target);
				continue;
			}
			if (entry.table !== table) continue;
			// Re-issuing through htmx keeps hx-select, OOB swaps and settling working
			// exactly as they do for a server-rendered response. Target and swap are
			// replayed from the read that established the binding rather than re-read
			// from the source, so a source that has since been swapped away cannot
			// redirect the update. `confirm` is cleared: a live update is not a user
			// action, and re-prompting on every peer edit would be intolerable.
			void htmx.ajax("GET", entry.action, {
				source: entry.source.isConnected ? entry.source : target,
				target,
				swap: entry.swap,
				confirm: null,
			});
		}
	}

	function refresh(table?: string): void {
		if (table === undefined) {
			for (const t of new Set([...bound.values()].map((e) => e.table))) renderTable(t);
			return;
		}
		renderTable(table);
	}

	// ── Serving a reflect: request ─────────────────────────────────────

	function serve(ctx: HtmxRequestContext, action: string, request: unknown): Promise<Response> {
		const method = (request as { method?: string })?.method ?? ctx.request.method;
		const body = (request as { body?: ReflectBody })?.body ?? ctx.request.body;
		const op = resolveOperation(action, method, body);

		if (!op) {
			return respond(500, `reflectdb: could not parse action "${action}"`);
		}
		if (op.kind === "error") {
			return respond(op.status, `reflectdb: ${op.message}`);
		}

		const binding = bindingFor(op.table);

		if (op.kind === "read") {
			// Remember the binding so store changes re-render it. Recorded on the
			// read rather than by scanning attributes, so any element htmx can
			// route — including one swapped in later — binds by using the adapter.
			const target = ctx.target ?? ctx.sourceElement;
			bound.set(target, {
				table: op.table,
				action,
				source: ctx.sourceElement,
				target,
				swap: ctx.swap,
			});

			const view = views.get(op.table);
			if (!view) {
				return respond(
					500,
					`reflectdb: no view registered for "${op.table}" — call .view("${op.table}", …)`,
				);
			}

			if (op.rowId !== undefined) {
				const row = sync.getRow(op.table, op.rowId);
				// 204 is in htmx's `noSwap` list, so a row that is missing (or was
				// just deleted) leaves the existing markup alone instead of blanking
				// it. Removal is the collection view's job.
				if (!row) return respond(204);
				return html(
					(view as ReflectView<object>)({
						rows: [row],
						table: op.table,
						rowId: op.rowId,
						params: op.params,
					}),
				);
			}

			return html(
				(view as ReflectView<object>)({
					rows: binding.getRows() as object[],
					table: op.table,
					params: op.params,
				}),
			);
		}

		// Writes are optimistic and local: they return 204 so htmx swaps nothing,
		// and the store change re-renders every bound element a beat later. That
		// keeps one render path whether the change came from this tab or a peer.
		if (op.kind === "remove") {
			binding.remove(op.rowId);
			return respond(204);
		}

		const parse = parsers.get(op.table) as ReflectParse<object> | undefined;
		const payload = parse ? (parse(op.payload) as Record<string, unknown>) : op.payload;

		if (op.kind === "insert") {
			binding.insert(op.rowId, payload);
		} else {
			binding.update(op.rowId, payload);
		}
		return respond(204);
	}

	function onConfigRequest(event: Event): void {
		const ctx = (event as CustomEvent<{ ctx?: HtmxRequestContext }>).detail?.ctx;
		if (!ctx || !parseReflectAction(ctx.request.action)) return;
		ctx.fetch = (action, request) => serve(ctx, action, request);
	}

	// ── Public surface ─────────────────────────────────────────────────

	const api: HtmxSync = {
		sync,

		view(table, view) {
			views.set(table, view as ReflectView<never>);
			return api;
		},

		parse(table, parse) {
			parsers.set(table, parse as ReflectParse<never>);
			return api;
		},

		install() {
			// Listening on `document` rather than through `htmx.on` because htmx 4
			// exposes no `off`, and an adapter that cannot detach leaks across hot
			// reloads. htmx dispatches the event on the source element with
			// `bubbles: true`, so document sees every one of them.
			if (!installed) {
				document.addEventListener(configRequestEvent, onConfigRequest);
				installed = true;
			}
			return api;
		},

		uninstall() {
			if (installed) {
				document.removeEventListener(configRequestEvent, onConfigRequest);
				installed = false;
			}
			bound.clear();
		},

		refresh,

		async connect() {
			api.install();
			await sync.connect();
		},

		async close() {
			closed = true;
			if (flushHandle !== null) {
				clearTimeout(flushHandle);
				flushHandle = null;
			}
			api.uninstall();
			for (const unsub of unsubscribes.values()) unsub();
			unsubscribes.clear();
			for (const binding of bindings.values()) binding.destroy();
			bindings.clear();
			await sync.close();
		},

		getState: () => sync.getState(),
		onStateChange: (cb) => sync.onStateChange(cb),
		getPendingCount: () => sync.getPendingCount(),
		onPendingChange: (cb) => sync.onPendingChange(cb),
	};

	return api;
}

// ── Response helpers ───────────────────────────────────────────────────

function html(markup: string): Promise<Response> {
	return Promise.resolve(new Response(markup, { status: 200, headers: HTML_HEADERS }));
}

function respond(status: number, message = ""): Promise<Response> {
	// 204 must carry a null body or the Response constructor throws.
	return Promise.resolve(
		new Response(status === 204 ? null : message, { status, headers: HTML_HEADERS }),
	);
}
