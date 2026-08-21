/**
 * The live half of the presence demo card.
 *
 * Every other demo on this page is a screenshot that links somewhere. This one
 * is the product running in place: the card connects to the same public
 * presence service an app would use, publishes your pointer, and draws every
 * other visitor's. Two people on the page at once see each other move.
 *
 * The markup it drives is rendered statically in `app.ts`, so the card reads
 * correctly with no JavaScript, no key configured, and no service reachable —
 * this module only ever upgrades it.
 */

import { createPresenceClient, type Peer } from "./presence/client.ts";

/** Overridable so `bun services/presence/dev.ts` can back the dev page. */
const PRESENCE_URL =
	import.meta.env.VITE_PRESENCE_URL ?? "https://reflectdb-presence.vercel.app/api/presence";

/** One room for the whole page — every visitor lands in the same one. */
const ROOM = "landing";

/**
 * Two channels, because a cursor and a person are not the same thing. A
 * connection that has not moved its pointer has published no cursor, so
 * counting the `cursor` channel would report an empty room full of people.
 * Every connection publishes on `here` the moment it joins.
 */
const CURSOR_CHANNEL = "cursor";
const HERE_CHANNEL = "here";

/**
 * The service accepts 30 writes per second per channel, and refuses anything
 * closer together. A `pointermove` listener fires far above that, so coalesce
 * to one publish per frame and never faster than this — comfortably outside
 * the 33ms the server would reject.
 */
const PUBLISH_INTERVAL_MS = 50;

/**
 * Long enough that a peer who stops moving stays visible, short enough that a
 * cursor left by a hard-closed tab expires rather than haunting the room.
 *
 * This carries more weight than it did over a socket. There is no connection
 * whose close the server can notice, so a leaving tab announces itself with a
 * beacon and the TTL is what covers every time that beacon does not get out.
 */
const TTL_MS = 20_000;

/**
 * Occupancy outlives pointer movement, so `here` gets a longer TTL and a
 * heartbeat. A reader who never moves their pointer publishes nothing else, so
 * without the heartbeat they would expire out of their own room.
 */
const HERE_TTL_MS = 90_000;
const HEARTBEAT_MS = 30_000;

const ADJECTIVES = [
	"swift",
	"clever",
	"brave",
	"sleepy",
	"sneaky",
	"jolly",
	"wild",
	"calm",
	"lucky",
	"grumpy",
	"fuzzy",
	"bold",
];
const ANIMALS = [
	"otter",
	"falcon",
	"badger",
	"panda",
	"heron",
	"lynx",
	"walrus",
	"gecko",
	"marmot",
	"puffin",
	"weasel",
	"moose",
];

/** Reads as distinct at a glance in both themes, unlike the token palette. */
const COLORS = ["#7df9a3", "#6ea8ff", "#ffb86b", "#c39bff", "#ff8fa3", "#5ee0d0"];

function pick<T>(list: readonly T[]): T {
	return list[Math.floor(Math.random() * list.length)]!;
}

interface Cursor {
	x: number;
	y: number;
}

interface Identity {
	name?: unknown;
	color?: unknown;
}

function identityOf(peer: Peer<Cursor>): { name: string; color: string } {
	const identity = (peer.identity ?? {}) as Identity;
	return {
		name: typeof identity.name === "string" ? identity.name : "someone",
		color: typeof identity.color === "string" ? identity.color : COLORS[0]!,
	};
}

/** Fractions, so a peer on a phone lands in the right place on a desktop. */
function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

export function mountPresenceDemo(root: HTMLElement): void {
	const surface = root.querySelector<HTMLElement>("[data-presence-surface]");
	const layer = root.querySelector<HTMLElement>("[data-presence-peers]");
	const stateEl = root.querySelector<HTMLElement>("[data-presence-state]");
	const countEl = root.querySelector<HTMLElement>("[data-presence-count]");
	const inviteEl = root.querySelector<HTMLElement>("[data-presence-invite]");
	if (!surface || !layer || !countEl) return;

	// Once the card has given up, later callbacks must not paint over the
	// reason it gave. The client keeps emitting after a fatal error — a state
	// change to "closed", a subscription notified with an empty room — and each
	// of those would otherwise overwrite the explanation with something that
	// looks like an ordinary empty board.
	let offline = false;
	const goOffline = (reason: string, forDevelopers?: string): void => {
		offline = true;
		root.classList.add("is-offline");
		root.classList.remove("is-connected", "has-peers", "is-active");
		if (stateEl) stateEl.textContent = "offline";
		countEl.textContent = reason;
		if (forDevelopers) console.warn(`[presence] ${forDevelopers}`);
	};

	const apiKey = import.meta.env.VITE_PRESENCE_KEY;
	if (!apiKey) {
		// No key configured for this build. Leave the static illustration up
		// rather than showing a card that looks perpetually disconnected.
		goOffline(
			"live cursors are off right now",
			"VITE_PRESENCE_KEY is unset, so the live cursor demo is disabled",
		);
		return;
	}

	const me = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) };
	const nodes = new Map<string, HTMLElement>();

	const presence = createPresenceClient({
		url: PRESENCE_URL,
		apiKey,
		room: ROOM,
		identity: me,
		ttlMs: TTL_MS,
		onStateChange: (state) => {
			if (offline) return;
			root.classList.toggle("is-connected", state === "connected");
			if (stateEl) {
				stateEl.textContent = state === "connected" ? "live" : state;
			}
		},
		onError: (error) => {
			// A fatal error means the client will not retry — a bad key, a
			// version mismatch, or a project at its ceiling. Say so instead of
			// leaving "connecting" on screen forever.
			if (error.fatal) goOffline("live cursors are off right now", error.message);
		},
	});

	presence.subscribe<Cursor>(CURSOR_CHANNEL, (peers) => {
		const seen = new Set<string>();

		for (const peer of peers) {
			if (typeof peer.data?.x !== "number" || typeof peer.data?.y !== "number") continue;
			seen.add(peer.clientId);

			let node = nodes.get(peer.clientId);
			if (!node) {
				node = document.createElement("div");
				node.className = "presence-cursor";
				node.innerHTML =
					'<svg viewBox="0 0 14 16" aria-hidden="true"><path d="M0 0l13 5-5 2-2 5z" /></svg><span></span>';
				layer.append(node);
				nodes.set(peer.clientId, node);
			}

			const { name, color } = identityOf(peer);
			node.style.setProperty("--peer-color", color);
			node.style.left = `${clamp01(peer.data.x) * 100}%`;
			node.style.top = `${clamp01(peer.data.y) * 100}%`;
			const label = node.querySelector("span");
			if (label && label.textContent !== name) label.textContent = name;
		}

		for (const [clientId, node] of nodes) {
			if (seen.has(clientId)) continue;
			node.remove();
			nodes.delete(clientId);
		}

		if (!offline) root.classList.toggle("has-peers", seen.size > 0);
	});

	// ── Occupancy ─────────────────────────────────────────────────────────

	presence.subscribe(HERE_CHANNEL, (peers) => {
		if (offline) return;
		const others = peers.length;
		countEl.textContent =
			others === 0 ? "you're the only one here" : `${others} other${others === 1 ? "" : "s"} here`;
		// Most visitors arrive at an empty room. Saying so and handing them the
		// one action that proves the point beats an empty grid, which reads as a
		// demo that failed to load.
		if (inviteEl) {
			inviteEl.textContent =
				others === 0 ? "open this page in a second tab" : "move your cursor in here";
		}
	});

	presence.publish(HERE_CHANNEL, {}, HERE_TTL_MS);
	window.setInterval(() => presence.publish(HERE_CHANNEL, {}, HERE_TTL_MS), HEARTBEAT_MS);

	// ── Publishing ────────────────────────────────────────────────────────

	let pending: Cursor | null = null;
	let lastSentAt = 0;
	let frame = 0;

	const flush = () => {
		frame = 0;
		if (!pending) return;
		lastSentAt = performance.now();
		presence.publish(CURSOR_CHANNEL, { ...pending });
		pending = null;
	};

	const schedule = () => {
		if (frame) return;
		const wait = Math.max(0, PUBLISH_INTERVAL_MS - (performance.now() - lastSentAt));
		frame = window.setTimeout(flush, wait);
	};

	surface.addEventListener("pointermove", (event) => {
		const rect = surface.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		pending = {
			x: clamp01((event.clientX - rect.left) / rect.width),
			y: clamp01((event.clientY - rect.top) / rect.height),
		};
		root.classList.add("is-active");
		schedule();
	});

	// Leaving the card should remove your cursor for everyone else at once,
	// not leave it parked at the edge until the TTL lapses.
	const stopPublishing = () => {
		if (frame) window.clearTimeout(frame);
		frame = 0;
		pending = null;
		root.classList.remove("is-active");
		presence.clear(CURSOR_CHANNEL);
	};

	surface.addEventListener("pointerleave", stopPublishing);
	surface.addEventListener("pointercancel", stopPublishing);

	// Nothing closes the client explicitly, and nothing here handles the page
	// unloading: the client sends its own leave beacon on `pagehide` and puts
	// its state back on `pageshow`, because every consumer needs that and none
	// of it is specific to this card.
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			// Your cursor should not sit on the board while you read another tab.
			stopPublishing();
			return;
		}
		// Background timers get throttled, so `here` may have expired while the
		// tab was away. Re-announce rather than wait for the next heartbeat.
		presence.publish(HERE_CHANNEL, {}, HERE_TTL_MS);
	});
}
