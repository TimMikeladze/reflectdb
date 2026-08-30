/**
 * Everything this demo renders is produced here, in the browser, from the
 * local reflectdb store. The server never sends a byte of HTML.
 */

import htmx from "htmx.org";
import { createSyncHtmx } from "../../src/htmx/index.ts";
import { queries } from "./schema.ts";

const { createHtmxSync } = createSyncHtmx<typeof queries>();

const reflect = createHtmxSync({
	htmx,
	url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sync`,
	token: "demo",
	tables: ["todos"],
	onError: (error) => {
		console.error("[reflectdb]", error);
		const banner = document.querySelector("#error");
		if (banner) banner.textContent = error.reason;
	},
});

// ── View ───────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ENTITIES[char] as string);
}

reflect.view("todos", ({ rows, params }) => {
	const filter = params.get("filter") ?? "all";
	const remaining = rows.filter((todo) => !todo.done).length;
	const visible = rows
		.filter((todo) => (filter === "done" ? todo.done : filter === "open" ? !todo.done : true))
		.sort((a, b) => a.createdAt - b.createdAt);

	// The counter rides along as an out-of-band swap, exactly as it would from a
	// server response: the adapter changes where the HTML comes from, not how
	// htmx applies it.
	const counter = `<span id="remaining" hx-swap-oob="true">${remaining} left</span>`;

	if (visible.length === 0) {
		return `${counter}<li class="empty">Nothing here yet.</li>`;
	}

	const items = visible.map((todo) => {
		const id = encodeURIComponent(todo.id);
		return `<li class="${todo.done ? "done" : ""}">
			<input type="checkbox" ${todo.done ? "checked" : ""}
				hx-put="reflect:todos/${id}"
				hx-vals='{"done": "${todo.done ? "false" : "true"}"}'>
			<span class="text">${escapeHtml(todo.text)}</span>
			<button class="remove" aria-label="Delete this todo"
				hx-delete="reflect:todos/${id}">&times;</button>
		</li>`;
	});

	return counter + items.join("");
});

// A form body is all strings; the schema wants a real boolean. `parse` sees
// only the fields that were submitted — the checkbox sends `done` alone — so it
// must build a patch rather than rebuild the row, or a toggle would blank the
// text it never received.
reflect.parse("todos", (payload) => {
	const patch: { text?: string; done?: boolean } = {};
	if ("text" in payload) patch.text = String(payload.text);
	if ("done" in payload) patch.done = payload.done === "true";
	return patch;
});

// ── Chrome ─────────────────────────────────────────────────────────────

const status = document.querySelector("#status");

reflect.onStateChange((state) => {
	if (status) status.textContent = state;
});

// The pending count is the offline story made visible: writes land in the DOM
// immediately and drain from this badge whenever the socket comes back.
const pending = document.querySelector("#pending");
reflect.onPendingChange((count) => {
	if (pending) pending.textContent = count > 0 ? `${count} unsynced` : "";
});

// Clear the composer once its insert has been applied locally.
htmx.on("htmx:after:request", (event) => {
	if (event.detail.ctx.request.method === "POST") {
		document.querySelector<HTMLFormElement>("#composer")?.reset();
	}
});

await reflect.connect();
if (status) status.textContent = reflect.getState();
