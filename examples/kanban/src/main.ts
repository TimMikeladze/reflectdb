/**
 * Kanban client.
 *
 * Uses `SyncClient` directly rather than the `reflectdb/vanilla` helper, which
 * builds its own WebSocket transport — this demo runs on Vercel functions,
 * which cannot hold a WebSocket, so it wires the SSE transport in serverless
 * mode explicitly. That wiring is most of what this example is here to show.
 */

import { SyncClient } from "../../../src/client/sync-client.ts";
import { createSseClientTransport } from "../../../src/transport/sse.ts";
import {
	COLUMNS,
	COLUMN_LABELS,
	type Card,
	type Column,
	positionBetween,
	sortCards,
} from "../schema.ts";

const params = new URLSearchParams(location.search);
const boardId = (params.get("board") ?? "demo").toLowerCase().replace(/[^a-z0-9-]/g, "") || "demo";
// Stable per tab, so a reload keeps the same session rather than orphaning one.
const clientId =
	sessionStorage.getItem("kanban:clientId") ??
	(() => {
		const id = crypto.randomUUID();
		sessionStorage.setItem("kanban:clientId", id);
		return id;
	})();

const query = `board=${encodeURIComponent(boardId)}&clientId=${encodeURIComponent(clientId)}`;

const client = new SyncClient({
	clientId,
	token: "anonymous",
	transport: createSseClientTransport({
		eventUrl: `/api/sync/events?${query}`,
		messageUrl: `/api/sync/messages?${query}`,
		// The POST and the stream are two different Vercel invocations, so replies
		// ride back on the POST. Without this the handshake never completes.
		serverless: true,
	}),
	onError: (error) => console.error("[kanban]", error.reason),
});

// ── elements ──────────────────────────────────────────────────────────────

const board = document.getElementById("board") as HTMLElement;
const statePill = document.getElementById("state-pill") as HTMLElement;
const stateLabel = document.getElementById("state-label") as HTMLElement;
const tape = document.getElementById("tape") as HTMLElement;
const pendingLabel = document.getElementById("pending") as HTMLElement;
const columnTemplate = document.getElementById("column-template") as HTMLTemplateElement;
const cardTemplate = document.getElementById("card-template") as HTMLTemplateElement;

// ── state readout ─────────────────────────────────────────────────────────

const STATE_COPY: Record<string, string> = {
	disconnected: "Disconnected",
	connecting: "Connecting",
	connected: "Connected",
	syncing: "Syncing",
	synced: "Live",
};

function renderState(): void {
	const state = client.getState();
	statePill.dataset.state = state;
	stateLabel.textContent = STATE_COPY[state] ?? state;

	const pending = client.getPendingCount();
	// Named for what it means to the person using the board — their edits are
	// made but not yet in the bucket — rather than for the queue it comes from.
	pendingLabel.textContent = pending > 0 ? `${pending} not yet saved` : "";
}

/**
 * One tick per batch that reached the bucket.
 *
 * Ticks are capped by what fits, oldest dropped first: the strip is a live
 * indicator, not a log, and letting it grow unbounded would leak a node per
 * write for as long as the tab is open.
 */
function addTick(): void {
	const tick = document.createElement("span");
	tick.className = "tape-tick";
	tape.append(tick);
	const capacity = Math.max(8, Math.floor(tape.clientWidth / 6));
	while (tape.childElementCount > capacity) tape.firstElementChild?.remove();
}

// ── board rendering ───────────────────────────────────────────────────────

/**
 * Whether the first snapshot has landed.
 *
 * `rows: []` means two different things — "the board is empty" and "the board
 * has not arrived yet" — and the client cannot tell them apart from the rows
 * alone. `synced` is what separates them: it is set on `bootstrap_complete`,
 * after every declared table's snapshot has been applied.
 *
 * Client-wide rather than per-table. That is fine here (one table), but note
 * that mounting a new table later triggers another bootstrap, so this briefly
 * reads false again for tables that were already loaded.
 */
function isReady(): boolean {
	return client.getState() === "synced";
}

function cards(): Card[] {
	return client.getRows("cards") as unknown as Card[];
}

function cardsIn(column: Column): Card[] {
	return sortCards(cards().filter((card) => card.column === column));
}

function moveCard(card: Card, column: Column, before: Card | null, after: Card | null): void {
	client.update("cards", card.id, {
		column,
		position: positionBetween(before?.position ?? null, after?.position ?? null),
	});
	void client.push();
	render();
}

/** Where a pointer at `y` would land within a column's card list. */
function dropTarget(list: HTMLElement, y: number, column: Column): [Card | null, Card | null] {
	const ordered = cardsIn(column);
	const items = [...list.querySelectorAll<HTMLElement>(".card:not(.dragging)")];
	for (let i = 0; i < items.length; i++) {
		const box = items[i]!.getBoundingClientRect();
		if (y < box.top + box.height / 2) {
			const id = items[i]!.dataset.id;
			const index = ordered.findIndex((card) => card.id === id);
			return [ordered[index - 1] ?? null, ordered[index] ?? null];
		}
	}
	return [ordered[ordered.length - 1] ?? null, null];
}

let dragging: string | null = null;

function renderCard(card: Card): HTMLElement {
	const node = cardTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
	node.dataset.id = card.id;
	node.querySelector(".card-title")!.textContent = card.title;
	node.setAttribute("aria-label", `${card.title}, in ${COLUMN_LABELS[card.column]}`);

	node.addEventListener("dragstart", (event) => {
		dragging = card.id;
		node.classList.add("dragging");
		(event as DragEvent).dataTransfer?.setData("text/plain", card.id);
	});
	node.addEventListener("dragend", () => {
		dragging = null;
		node.classList.remove("dragging");
	});

	// Keyboard equivalent for the drag, so the board is usable without a pointer.
	for (const button of node.querySelectorAll<HTMLElement>("[data-move]")) {
		button.addEventListener("click", () => {
			const delta = Number(button.dataset.move);
			const index = COLUMNS.indexOf(card.column);
			const next = COLUMNS[index + delta];
			if (!next) return;
			const target = cardsIn(next);
			moveCard(card, next, target[target.length - 1] ?? null, null);
		});
	}
	node.querySelector("[data-remove]")!.addEventListener("click", () => {
		client.delete("cards", card.id);
		void client.push();
		render();
	});

	return node;
}

function render(): void {
	renderState();
	board.replaceChildren();
	const ready = isReady();

	for (const column of COLUMNS) {
		const node = columnTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
		const list = node.querySelector(".cards") as HTMLElement;
		const items = cardsIn(column);

		node.querySelector("h2")!.textContent = COLUMN_LABELS[column];
		node.querySelector(".count")!.textContent = ready ? String(items.length) : "";

		if (!ready) {
			// Placeholders rather than "no cards yet": telling someone the board is
			// empty when it has simply not loaded invites them to re-add work that
			// is about to appear.
			node.setAttribute("aria-busy", "true");
			for (let i = 0; i < 2; i++) {
				const skeleton = document.createElement("li");
				skeleton.className = "card skeleton";
				skeleton.setAttribute("aria-hidden", "true");
				list.append(skeleton);
			}
		} else if (items.length === 0) {
			const empty = document.createElement("li");
			empty.className = "empty";
			empty.textContent = column === "todo" ? "Add the first card." : "Nothing here yet.";
			list.append(empty);
		} else {
			for (const card of items) list.append(renderCard(card));
		}

		node.addEventListener("dragover", (event) => {
			event.preventDefault();
			node.classList.add("dropping");
		});
		node.addEventListener("dragleave", () => node.classList.remove("dropping"));
		node.addEventListener("drop", (event) => {
			event.preventDefault();
			node.classList.remove("dropping");
			const id = dragging ?? (event as DragEvent).dataTransfer?.getData("text/plain");
			const card = cards().find((c) => c.id === id);
			if (!card) return;
			const [before, after] = dropTarget(list, (event as DragEvent).clientY, column);
			moveCard(card, column, before, after);
		});

		const form = node.querySelector(".composer") as HTMLFormElement;
		const input = form.querySelector("input") as HTMLInputElement;
		const submit = form.querySelector("button") as HTMLButtonElement;
		// Writes made before the snapshot are NOT lost — `applySnapshot` re-applies
		// pending optimistic ops after clearing the table — so this is about not
		// asking someone to type into a board whose contents they cannot see yet.
		input.disabled = !ready;
		submit.disabled = !ready;
		input.placeholder = ready ? "Add a card" : "Loading…";

		form.addEventListener("submit", (event) => {
			event.preventDefault();
			if (!isReady()) return;
			const title = input.value.trim();
			if (!title) return;
			const existing = cardsIn(column);
			const id = crypto.randomUUID();
			client.insert("cards", id, {
				// `id` has to be IN the payload, not just the row id. The server
				// stores the resolved payload as the row, and the query's primary
				// key is `id` — a row without it keys to the empty string, so every
				// card collapses onto one entry and the board shows a single card.
				id,
				title,
				column,
				position: positionBetween(existing[existing.length - 1]?.position ?? null, null),
			});
			void client.push();
			input.value = "";
			render();
		});

		board.append(node);
	}
}

// ── wiring ────────────────────────────────────────────────────────────────

client.subscribeTable("cards", render);
// A full re-render on state change, not just the status pill: the columns
// themselves switch between skeletons and content on `synced`.
let lastReady = isReady();
client.subscribe(() => {
	const ready = isReady();
	if (ready !== lastReady) {
		lastReady = ready;
		render();
	} else {
		renderState();
	}
});
// A batch reaching the bucket is what retires pending ops, so a drop in the
// pending count is the client-visible signal that a write is durable.
let lastPending = 0;
client.subscribe(() => {
	const pending = client.getPendingCount();
	if (pending < lastPending) addTick();
	lastPending = pending;
});

document.getElementById("share")!.addEventListener("click", async (event) => {
	const button = event.currentTarget as HTMLButtonElement;
	await navigator.clipboard.writeText(location.href);
	button.textContent = "Link copied";
	setTimeout(() => {
		button.textContent = "Copy board link";
	}, 1600);
});

render();

void (async () => {
	await client.connect();
	await client.sync("cards");
	await client.bootstrap();
	render();
})();
