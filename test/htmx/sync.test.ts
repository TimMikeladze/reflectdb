import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHtmxSync } from "../../src/htmx/sync.ts";
import type { HtmxRequestContext, HtmxSync } from "../../src/htmx/sync.ts";

// ── Test doubles ───────────────────────────────────────────────────────
//
// Bun's runner has no DOM, so this stands in for the three things the adapter
// touches: `document` as an event target, htmx's `ajax` entry point, and the
// WebSocket the vanilla transport opens on the first push.

interface FakeElement {
	isConnected: boolean;
	html: string | null;
	status: number;
}

function element(): FakeElement {
	return { isConnected: true, html: null, status: 0 };
}

/**
 * A swap target holding one checkbox, enough for `resyncToggles`: the DOM
 * property is whatever a click last left it at, the content attribute is
 * whatever the freshly swapped markup says.
 */
interface FakeToggleTarget extends FakeElement {
	checkbox: { checked: boolean; tagName: string; hasAttribute(name: string): boolean };
	querySelectorAll(selector: string): FakeToggleTarget["checkbox"][];
	matches(selector: string): boolean;
}

function toggleTarget(): FakeToggleTarget {
	const target: FakeToggleTarget = {
		...element(),
		checkbox: {
			checked: false,
			tagName: "INPUT",
			hasAttribute: (name) => name === "checked" && (target.html ?? "").includes("checked"),
		},
		querySelectorAll: () => [target.checkbox],
		matches: () => false,
	};
	return target;
}

class FakeDocument {
	listeners = new Map<string, Set<(event: Event) => void>>();

	addEventListener(type: string, cb: (event: Event) => void): void {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)?.add(cb);
	}

	removeEventListener(type: string, cb: (event: Event) => void): void {
		this.listeners.get(type)?.delete(cb);
	}

	dispatch(type: string, detail: unknown): void {
		for (const cb of this.listeners.get(type) ?? []) {
			cb({ type, detail } as unknown as Event);
		}
	}
}

/**
 * Enough of htmx's request pipeline to exercise the adapter: build a context,
 * fire `htmx:config:request`, default `ctx.fetch` the way htmx does, then
 * "swap" the response into the source element. 204 swaps nothing, matching
 * htmx's `noSwap` config.
 */
function fakeHtmx(doc: FakeDocument) {
	const calls: { verb: string; path: string }[] = [];
	return {
		calls,
		async ajax(verb: string, path: string, options: Record<string, unknown> = {}) {
			calls.push({ verb, path });
			const source = (options.source as FakeElement | undefined) ?? element();
			// htmx resolves hx-target before firing config:request, defaulting to
			// the source element.
			const target = (options.target as FakeElement | undefined) ?? source;
			const ctx: HtmxRequestContext = {
				sourceElement: source as unknown as Element,
				target: target as unknown as Element,
				swap: options.swap as string | undefined,
				request: {
					action: path,
					method: verb.toUpperCase(),
					headers: {},
					body: options.body as never,
				},
			};
			doc.dispatch("htmx:config:request", { ctx });
			ctx.fetch ??= async () => new Response("network", { status: 599 });
			const response = await ctx.fetch(ctx.request.action, ctx.request);
			const swapped = (ctx.target ?? ctx.sourceElement) as unknown as FakeElement;
			swapped.status = response.status;
			if (response.status !== 204) swapped.html = await response.text();
			return response;
		},
	};
}

class FakeWebSocket {
	static readonly CLOSED = 3;
	static readonly CLOSING = 2;
	static readonly OPEN = 1;
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((e: unknown) => void) | null = null;
	onclose: (() => void) | null = null;
	send(): void {}
	close(): void {}
}

// A macrotask, matching the adapter's own re-render scheduling.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── Fixture ────────────────────────────────────────────────────────────

let doc: FakeDocument;
let htmx: ReturnType<typeof fakeHtmx>;
let reflect: HtmxSync;
const originals: { document: unknown; webSocket: unknown } = {
	document: undefined,
	webSocket: undefined,
};

beforeEach(() => {
	doc = new FakeDocument();
	htmx = fakeHtmx(doc);
	originals.document = (globalThis as Record<string, unknown>).document;
	originals.webSocket = (globalThis as Record<string, unknown>).WebSocket;
	(globalThis as Record<string, unknown>).document = doc;
	(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;

	reflect = createHtmxSync({
		htmx,
		url: "ws://localhost:0/sync",
		token: "test-token",
		// Declared up front so the binding never issues its own subscribe —
		// `connect()` is what would talk to a server, and these tests do not.
		tables: ["todos"],
	});
	reflect.install();
});

afterEach(() => {
	reflect.uninstall();
	(globalThis as Record<string, unknown>).document = originals.document;
	(globalThis as Record<string, unknown>).WebSocket = originals.webSocket;
});

function todoList() {
	reflect.view<{ id: string; text: string }>("todos", ({ rows }) =>
		rows.map((row) => `<li data-id="${row.id}">${row.text}</li>`).join(""),
	);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("createHtmxSync", () => {
	test("a GET renders the registered view from local rows", async () => {
		todoList();
		const list = element();

		await htmx.ajax("POST", "reflect:todos", {
			source: element(),
			body: new URLSearchParams({ id: "t1", text: "buy milk" }),
		});
		await htmx.ajax("GET", "reflect:todos", { source: list });

		expect(list.status).toBe(200);
		expect(list.html).toBe('<li data-id="t1">buy milk</li>');
	});

	test("writes return 204 so htmx swaps nothing, and the store re-renders", async () => {
		todoList();
		const list = element();
		await htmx.ajax("GET", "reflect:todos", { source: list });
		expect(list.html).toBe("");

		const form = element();
		await htmx.ajax("POST", "reflect:todos", {
			source: form,
			body: new URLSearchParams({ id: "t1", text: "buy milk" }),
		});

		// The write itself swaps nothing into the form.
		expect(form.status).toBe(204);
		expect(form.html).toBeNull();

		// The bound list re-renders on the store change, one beat later.
		await tick();
		expect(list.html).toBe('<li data-id="t1">buy milk</li>');
	});

	test("PUT updates and DELETE removes, both re-rendering bound elements", async () => {
		todoList();
		const list = element();
		await htmx.ajax("GET", "reflect:todos", { source: list });

		await htmx.ajax("POST", "reflect:todos", {
			source: element(),
			body: new URLSearchParams({ id: "t1", text: "draft" }),
		});
		await tick();

		await htmx.ajax("PUT", "reflect:todos/t1", {
			source: element(),
			body: new URLSearchParams({ text: "final" }),
		});
		await tick();
		expect(list.html).toBe('<li data-id="t1">final</li>');

		await htmx.ajax("DELETE", "reflect:todos/t1", { source: element() });
		await tick();
		expect(list.html).toBe("");
	});

	test("a peer's change re-checks a checkbox the user has already clicked", async () => {
		// Once clicked, a checkbox's dirty flag stops the `checked` attribute from
		// driving the property, and htmx's morph only fixes that up for `value`.
		// Without the resync, a peer un-ticking the row would leave this tab's box
		// ticked while the rest of the row rendered as open.
		reflect.view<{ id: string; done: boolean }>("todos", ({ rows }) =>
			rows.map((row) => `<input type="checkbox"${row.done ? " checked" : ""}>`).join(""),
		);
		const list = toggleTarget();
		await htmx.ajax("GET", "reflect:todos", { source: list });

		await htmx.ajax("POST", "reflect:todos", {
			source: element(),
			body: new URLSearchParams({ id: "t1", done: "true" }),
		});
		await tick();
		expect(list.html).toBe('<input type="checkbox" checked>');

		// The user clicked it, so the property is theirs now.
		list.checkbox.checked = true;

		await htmx.ajax("PUT", "reflect:todos/t1", {
			source: element(),
			body: new URLSearchParams({ done: "" }),
		});
		await tick();

		expect(list.html).toBe('<input type="checkbox">');
		expect(list.checkbox.checked).toBe(false);
	});

	test("a row read renders just that row", async () => {
		reflect.view<{ id: string; text: string }>(
			"todos",
			({ rows, rowId }) => `<span data-row="${rowId}">${rows[0]?.text}</span>`,
		);
		await htmx.ajax("POST", "reflect:todos", {
			source: element(),
			body: new URLSearchParams({ id: "t1", text: "one" }),
		});

		const row = element();
		await htmx.ajax("GET", "reflect:todos/t1", { source: row });
		expect(row.html).toBe('<span data-row="t1">one</span>');
	});

	test("a missing row is a 204 so existing markup is left alone", async () => {
		todoList();
		const row = element();
		row.html = "<span>stale but better than blank</span>";
		await htmx.ajax("GET", "reflect:todos/nope", { source: row });

		expect(row.status).toBe(204);
		expect(row.html).toBe("<span>stale but better than blank</span>");
	});

	test("parse coerces the form body before it reaches the op log", async () => {
		reflect.view<{ id: string; done: boolean }>("todos", ({ rows }) =>
			rows.map((row) => `${row.id}:${typeof row.done}:${row.done}`).join(""),
		);
		reflect.parse<{ id: string; done: boolean }>("todos", (payload) => ({
			...(payload as { id: string }),
			done: payload.done === "on",
		}));

		await htmx.ajax("POST", "reflect:todos", {
			source: element(),
			body: new URLSearchParams({ id: "t1", done: "on" }),
		});

		const list = element();
		await htmx.ajax("GET", "reflect:todos", { source: list });
		expect(list.html).toBe("t1:boolean:true");
	});

	test("an unregistered view fails loudly rather than swapping nothing", async () => {
		const list = element();
		await htmx.ajax("GET", "reflect:todos", { source: list });
		expect(list.status).toBe(500);
		expect(list.html).toContain('no view registered for "todos"');
	});

	test("a bad action reports the status htmx will surface", async () => {
		todoList();
		const el = element();
		await htmx.ajax("DELETE", "reflect:todos", { source: el });
		expect(el.status).toBe(400);
	});

	test("non-reflect actions are left to the network", async () => {
		const el = element();
		await htmx.ajax("GET", "/api/todos", { source: el });
		expect(el.status).toBe(599);
	});

	test("detached elements stop re-rendering and are dropped", async () => {
		todoList();
		const list = element();
		await htmx.ajax("GET", "reflect:todos", { source: list });

		list.isConnected = false;
		const before = htmx.calls.length;
		await htmx.ajax("POST", "reflect:todos", {
			source: element(),
			body: new URLSearchParams({ id: "t1", text: "x" }),
		});
		await tick();

		// One call for the POST, none for the detached list.
		expect(htmx.calls.length).toBe(before + 1);
	});

	// A filter button and the list it points at are two sources for one target.
	// Keying bindings by target keeps the most recent read in charge instead of
	// letting both re-render the same element on every change.
	test("the newest read owns the target it painted", async () => {
		reflect.view<{ id: string; text: string; done: boolean }>("todos", ({ rows, params }) => {
			const filter = params.get("filter");
			return rows
				.filter((row) => (filter === "open" ? !row.done : true))
				.map((row) => `<li>${row.text}</li>`)
				.join("");
		});
		reflect.parse<{ id: string; text: string; done: boolean }>("todos", (payload) => ({
			...(payload as { id: string; text: string }),
			done: payload.done === "true",
		}));

		const list = element();
		await htmx.ajax("GET", "reflect:todos", { source: list });

		// A filter button reads the same table into the same target.
		const filterButton = element();
		await htmx.ajax("GET", "reflect:todos?filter=open", { source: filterButton, target: list });
		expect(list.html).toBe("");

		await htmx.ajax("POST", "reflect:todos", {
			source: element(),
			body: new URLSearchParams({ id: "t1", text: "open one", done: "false" }),
		});
		await htmx.ajax("POST", "reflect:todos", {
			source: element(),
			body: new URLSearchParams({ id: "t2", text: "closed one", done: "true" }),
		});
		await tick();

		// One binding re-rendered, and it kept the filter.
		expect(list.html).toBe("<li>open one</li>");
	});

	test("uninstall detaches the shim", async () => {
		todoList();
		reflect.uninstall();
		const el = element();
		await htmx.ajax("GET", "reflect:todos", { source: el });
		expect(el.status).toBe(599);
	});

	test("refresh re-renders on demand", async () => {
		todoList();
		const list = element();
		await htmx.ajax("GET", "reflect:todos", { source: list });

		reflect.sync.client.insert("todos", "t1", { text: "from a peer" });
		list.html = null;
		reflect.refresh("todos");
		await tick();

		expect(list.html).toBe('<li data-id="t1">from a peer</li>');
	});
});
