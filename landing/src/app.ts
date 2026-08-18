import * as D from "./diagrams.ts";
import { escapeHtml, highlight } from "./highlight.ts";
import * as S from "./snippets.ts";

const REPO = "https://github.com/TimMikeladze/reflectdb";
const TETRIS_DEMO = "https://reflectdb-tetris.fly.dev/";

/**
 * Cycled through by the hero typewriter. Every one of these is something
 * reflectdb actually runs on or against — the line is a claim, not a mood board.
 */
const ROTATING = [
	"TypeScript",
	"React",
	"Svelte",
	"vanilla JS",
	"Bun",
	"Node",
	"Postgres",
	"SQLite",
	"Drizzle",
	"Kysely",
	"WebSocket",
	"SSE",
	"polling",
	"Vercel",
	"your own stack",
];

// ── Building blocks ─────────────────────────────────────────────────────

function code(label: string, src: string): string {
	return `<div class="code"><div class="label">${escapeHtml(label)}</div><pre>${highlight(
		src,
	)}</pre></div>`;
}

function plain(label: string, src: string): string {
	return `<div class="code"><div class="label">${escapeHtml(label)}</div><pre class="dim">${escapeHtml(
		src,
	)}</pre></div>`;
}

function fig(svg: string, caption: string): string {
	return `<figure class="fig">${svg}<figcaption>${caption}</figcaption></figure>`;
}

function section(id: string, kicker: string, title: string, body: string): string {
	return `<section id="${id}">
    <h2>${escapeHtml(kicker)}</h2>
    <h3 class="section-title">${escapeHtml(title)}</h3>
    ${body}
  </section>`;
}

interface Card {
	title: string;
	desc: string;
	src: string;
}

function cards(items: Card[]): string {
	return `<div class="cards">${items
		.map(
			(c) => `<article class="card">
        <h4><span class="dot">▸</span>${escapeHtml(c.title)}</h4>
        <p>${escapeHtml(c.desc)}</p>
        <pre>${highlight(c.src)}</pre>
      </article>`,
		)
		.join("")}</div>`;
}

function steps(items: Array<[string, string]>): string {
	return `<ol class="steps">${items
		.map(([t, d]) => `<li><strong>${escapeHtml(t)}</strong><span>${escapeHtml(d)}</span></li>`)
		.join("")}</ol>`;
}

// ── Content ─────────────────────────────────────────────────────────────

const FEATURE_CARDS: Card[] = [
	{
		title: "End-to-end types",
		desc: "The schema is the only source of truth. Row types, params, and the writable subset flow to server and client with no codegen step.",
		src: S.F_TYPES,
	},
	{
		title: "Offline-first",
		desc: "Writes apply locally, queue in IndexedDB, and replay in order on reconnect. Nothing about the API changes when the network dies.",
		src: S.F_OFFLINE,
	},
	{
		title: "Typed params",
		desc: "Declare params and the client is forced to pass them; the server uses them to scope the query.",
		src: S.F_PARAMS,
	},
	{
		title: "Rooms",
		desc: "Pin a subscription to a tenant. Room resolution fails closed — a half-addressed pattern is rejected, never widened.",
		src: S.F_ROOMS,
	},
	{
		title: "Auth and authorize",
		desc: "One auth callback per connection and per op push. authorize runs on both reads and writes.",
		src: S.F_AUTH,
	},
	{
		title: "Validate what clients send",
		desc: "Types erase at runtime. reflectdb checks protocol structure, never payload contents — validate in mutate with whatever you already use.",
		src: S.F_VALIDATE,
	},
	{
		title: "Per-column merge",
		desc: "Two people editing different fields of the same row both win, ordered by per-column HLCs rather than arrival time.",
		src: S.F_MERGE,
	},
	{
		title: "Bring your own database",
		desc: "query and mutate get your db handle untouched. Drizzle, Kysely, Prisma, raw SQL, or a Map.",
		src: S.F_BYODB,
	},
	{
		title: "Ephemeral channels",
		desc: "Cursors, presence and typing indicators bypass the op log entirely — room-scoped, TTL'd, never persisted.",
		src: S.F_EPHEMERAL,
	},
	{
		title: "Typed presence",
		desc: "Declare the presence shape in the schema and the key is derived for you.",
		src: S.F_PRESENCE,
	},
	{
		title: "Read-only views",
		desc: "Computed queries that recompute on their dependencies. Writes are blocked at the type level and at runtime.",
		src: S.F_VIEW,
	},
	{
		title: "Windowed sync",
		desc: "Sync a sliding window instead of a whole table. Supply count and the window becomes a real SQL LIMIT.",
		src: S.F_WINDOW,
	},
	{
		title: "Auto-generated REST",
		desc: "CRUD endpoints derived from the schema, running the same pipeline — REST writes broadcast to live subscribers.",
		src: S.F_REST,
	},
	{
		title: "Rate limiting",
		desc: "Global and per-table budgets. Ephemeral traffic is metered separately and always, because each message fans out.",
		src: S.F_RATE,
	},
	{
		title: "High availability",
		desc: "Share the op log in Postgres. Clients reconnecting to a different instance resume from their watermark.",
		src: S.F_HA,
	},
	{
		title: "Server-driven state",
		desc: "Timers, expiry, round rotation — anything that advances without user input. Locks keep a tick from outrunning itself.",
		src: S.F_LOOP,
	},
	{
		title: "Per-user query results",
		desc: "A query is a function of auth, so two subscribers can be handed different rows and both stay live.",
		src: S.F_PERUSER,
	},
	{
		title: "Soft deletes",
		desc: "deletedAt columns are respected on read without any configuration.",
		src: S.F_SOFTDELETE,
	},
	{
		title: "Observability",
		desc: "A single event stream for connection, write, query and compaction lifecycle.",
		src: S.F_EVENTS,
	},
	{
		title: "Storage adapters",
		desc: "Swap the op log and the browser store independently. Everything else stays identical.",
		src: S.STORAGE,
	},
];

// ── Page ────────────────────────────────────────────────────────────────

export function renderApp(root: HTMLElement): void {
	root.innerHTML = `
    <header>
      <div class="brand">reflectdb</div>
      <nav>
        <a href="#how">how it works</a>
        <a href="#demos">demo</a>
        <a href="#quickstart">quickstart</a>
        <a href="#concepts">concepts</a>
        <a href="#features">features</a>
        <a href="#transports">transports</a>
      </nav>
      <a class="gh" href="${REPO}">github</a>
    </header>

    <section id="hero">
      <h1>real-time sync engine<br/>for <span class="accent" id="rotator" aria-hidden="true">${ROTATING[0]}</span><span class="period">.</span><span class="sr-only">${ROTATING.join(", ")}</span><span class="cursor"></span></h1>
      <p class="tagline">
        Keep a server-side database in sync with any number of browser clients —
        offline-first, with optimistic local writes, automatic conflict resolution,
        and end-to-end type inference. Bring your own types and your own database.
      </p>

      <div class="cta">
        <a class="btn primary" href="#quickstart">quickstart →</a>
        <a class="btn" href="#demos">live demo</a>
        <a class="btn" href="#how">how it works</a>
        <a class="btn" href="${REPO}">view on github</a>
      </div>

      <div class="install">
        <code><span class="prompt">$</span>bun add reflectdb</code>
        <button class="copy-btn" data-copy="bun add reflectdb">copy</button>
      </div>
    </section>

    ${section(
			"demos",
			"live demo",
			"See the sync engine move",
			`
      <article class="demo-feature">
        <div class="demo-copy">
          <div class="demo-status"><span></span>deployed on fly.io · wakes on demand</div>
          <h4>Infinite multiplayer Tetris</h4>
          <p>
            One perpetual game, one server-authoritative well per visitor. Inputs render
            optimistically, reconcile against Bun SQLite, and fan out to every connected
            player in real time.
          </p>
          <ul class="demo-facts">
            <li>open two tabs to add another player</li>
            <li>difficulty rises independently per well</li>
            <li>top-out resets only your own run</li>
          </ul>
          <div class="demo-actions">
            <a class="btn primary" href="${TETRIS_DEMO}">play the demo →</a>
            <a class="btn" href="${REPO}/tree/main/examples/tetris">view source</a>
          </div>
          <p class="demo-hint">The first load may take a moment while the Fly Machine starts.</p>
        </div>

        <a class="demo-preview" href="${TETRIS_DEMO}" aria-label="Open the infinite multiplayer Tetris demo">
          <div class="demo-chrome">
            <span class="demo-chrome-dot"></span>
            <span>reflectdb-tetris.fly.dev</span>
            <span class="demo-synced">synced</span>
          </div>
          <div class="demo-game">
            <div class="demo-player">
              <span>01</span>
              <strong>electric-tiger-42</strong>
              <span>2,840</span>
            </div>
            <svg viewBox="0 0 260 300" role="img" aria-label="A stylized Tetris well synchronized in real time">
              <rect class="demo-well" x="55" y="12" width="150" height="276" rx="2" />
              <g class="demo-grid">
                <path d="M70 12V288M85 12V288M100 12V288M115 12V288M130 12V288M145 12V288M160 12V288M175 12V288M190 12V288" />
                <path d="M55 27H205M55 42H205M55 57H205M55 72H205M55 87H205M55 102H205M55 117H205M55 132H205M55 147H205M55 162H205M55 177H205M55 192H205M55 207H205M55 222H205M55 237H205M55 252H205M55 267H205" />
              </g>
              <g class="demo-ghost">
                <rect x="115" y="222" width="15" height="15" /><rect x="130" y="222" width="15" height="15" />
                <rect x="130" y="237" width="15" height="15" /><rect x="145" y="237" width="15" height="15" />
              </g>
              <g class="demo-piece">
                <rect x="115" y="72" width="15" height="15" /><rect x="130" y="72" width="15" height="15" />
                <rect x="130" y="87" width="15" height="15" /><rect x="145" y="87" width="15" height="15" />
              </g>
              <g class="demo-stack">
                <rect x="55" y="267" width="15" height="15" /><rect x="70" y="267" width="15" height="15" />
                <rect x="85" y="267" width="15" height="15" /><rect x="115" y="267" width="15" height="15" />
                <rect x="130" y="267" width="15" height="15" /><rect x="145" y="267" width="15" height="15" />
                <rect x="160" y="267" width="15" height="15" /><rect x="190" y="267" width="15" height="15" />
                <rect x="55" y="252" width="15" height="15" /><rect x="85" y="252" width="15" height="15" />
                <rect x="100" y="252" width="15" height="15" /><rect x="115" y="252" width="15" height="15" />
                <rect x="145" y="252" width="15" height="15" /><rect x="160" y="252" width="15" height="15" />
                <rect x="175" y="252" width="15" height="15" /><rect x="190" y="252" width="15" height="15" />
                <rect x="55" y="237" width="15" height="15" /><rect x="70" y="237" width="15" height="15" />
                <rect x="85" y="237" width="15" height="15" /><rect x="100" y="237" width="15" height="15" />
                <rect x="160" y="237" width="15" height="15" /><rect x="175" y="237" width="15" height="15" />
                <rect x="190" y="237" width="15" height="15" />
              </g>
            </svg>
            <div class="demo-stats">
              <span><small>level</small><strong>04</strong></span>
              <span><small>lines</small><strong>18</strong></span>
              <span><small>next</small><strong class="next-piece">▟</strong></span>
            </div>
          </div>
          <div class="demo-preview-footer"><span>← → move · ↑ rotate · space drop</span><strong>play →</strong></div>
        </a>
      </article>
    `,
		)}

    ${section(
			"how",
			"how it works",
			"One write, end to end",
			`
      ${fig(D.topology, "Clients hold an optimistic copy. The server owns the database and the op log.")}

      <p class="note">
        Every client keeps a local copy it may write to immediately. Every write becomes an
        <em>op</em> — a row-scoped insert, update or delete stamped with a hybrid logical clock.
        The server is the only thing that decides what an op means, and the only thing that
        talks to your database.
      </p>

      ${fig(
				D.writePath,
				"The full path of a single write. Every gate runs on every op, on every path in — sync, REST, or server-side.",
			)}

      ${steps([
				[
					"The UI never waits",
					"applyOptimistic patches the local row before anything hits the wire; the pending op is durable before the send, not after.",
				],
				[
					"Ops are idempotent",
					"Each op id is reserved with a single compare-and-set, so a resend after a dropped frame is accepted once and acked, never applied twice.",
				],
				[
					"Batches are all-or-nothing",
					"A message carries up to 100 ops. Ops sharing a batchId fail together, and the client never splits a batch across messages.",
				],
				[
					"Rejection is not data loss",
					"A reject carries a reason and the server's row; the client reverts to the exact state it captured before the op was applied.",
				],
			])}

      <h3 class="sub">Then: who gets told</h3>
      ${fig(D.fanout, "A write becomes deltas by re-running the queries that depend on it.")}
      <div class="grid-2">
        ${plain("the diff that becomes a delta", S.DIFF_EXAMPLE)}
        <p class="note">
          Deltas describe state, not events. Two writes that land on the same final value
          produce nothing on the wire, and an update carries only the columns that actually
          moved. The cached result set is committed only after every send resolves — a
          dropped frame means the next broadcast re-emits it rather than silently skipping it.
        </p>
      </div>
    `,
		)}

    ${section(
			"quickstart",
			"quickstart",
			"Thirty lines, no ORM, no database",
			`
      ${code("schema.ts", S.SCHEMA)}
      <div class="grid-2">
        ${code("server.ts", S.SERVER)}
        ${code("app.tsx", S.CLIENT)}
      </div>
      ${code("wiring the transport — Bun shown, any fetch-compatible server works", S.WIRE)}
      <p class="note">
        Open two tabs; edits in one appear in the other within a round trip. Close the laptop,
        keep editing, reopen — the queue replays. Swap the Map for Drizzle, Kysely, Prisma or
        raw SQL without touching the client.
      </p>
    `,
		)}

    ${section(
			"concepts",
			"core concepts",
			"The four things worth understanding",
			`
      <h3 class="sub">1 · Hybrid logical clocks</h3>
      <div class="grid-2">
        ${code("reflectdb/core", S.HLC)}
        <p class="note">
          Ordering across machines without synchronized wall clocks. An HLC is
          <code>(ms, counter, nodeId)</code>, packed into a zero-padded string so plain
          string comparison gives causal order — conflict resolution costs a
          <code>&lt;</code>. The clock ratchets forward on every exchange in both
          directions, and a remote timestamp is clamped to five minutes ahead of local
          wall time so a broken client clock cannot poison the deployment.
        </p>
      </div>

      <h3 class="sub">2 · Conflict resolution</h3>
      ${fig(
				D.conflict,
				"Policies only diverge when ops arrive out of causal order — which is exactly when it matters.",
			)}
      ${code("schema.ts — chosen per query", S.CONFLICT)}
      <p class="note">
        Resolution compares the incoming op against reflectdb's mirror: a JSONB row plus a
        clock per column. A custom resolver receives the incoming op, the existing row and
        its clocks, and returns the resolved row — or throws to reject with a reason the
        client can switch on.
      </p>

      <h3 class="sub">3 · Two stores, one sync</h3>
      ${fig(D.twoStores, "Your database answers every read a client sees. The mirror answers every question about causality.")}
      <p class="note">
        A write lands in two places, in two commits: your <code>mutate</code> writes your
        database, and reflectdb writes its mirror row plus the op-log entry together.
        Snapshots and deltas always come from <em>your</em> database, so clients converge even
        if the mirror lags. Keep <code>mutate</code> a faithful application of
        <code>op.payload</code> and route out-of-band writes back through the server, and the
        two never disagree.
      </p>
      ${code("server.ts — writes that did not come from a client", S.SERVER_ORIGIN)}

      <h3 class="sub">4 · The op log, resume and compaction</h3>
      ${fig(D.resume, "Reconnect is a resume, not a re-download — and a compacted watermark degrades to a bootstrap.")}
      <div class="grid-2">
        ${code("server.ts", S.COMPACTION)}
        <p class="note">
          Every accepted mutation is appended to the op log with its HLC. On reconnect the
          client sends its watermark; the server asks the log which <em>tables</em> changed
          since then and re-runs only the affected queries. Replaying the queries rather than
          the ops is what keeps tenant filters and per-user results correct on resume — and
          what makes failover to another instance a non-event when the log lives in Postgres.
        </p>
      </div>

      <h3 class="sub">Broadcast modes</h3>
      ${fig(D.broadcastModes, "Consistent re-reads your database and diffs. Eager forwards the row it already has.")}
      ${code("server.ts", S.EAGER)}
      <p class="note">
        Both eager modes trade the conflict pass for latency: writes land last-writer-wins
        regardless of the declared policy. <code>eager-durable</code> persists before it
        broadcasts; plain <code>eager</code> batches the mirror write in the background, so
        only use it when your own database is the durable copy.
      </p>

      <h3 class="sub">Scaling the fan-out</h3>
      ${code("server.ts", S.GROUP_BY)}
      <p class="note">
        Subscribers are grouped by everything that can change a result — auth, params, room —
        so per-user auth means one query execution per connected client. Return the coarser
        key the query actually depends on and they collapse into one. Two clients sharing a
        key must be entitled to byte-identical rows.
      </p>
    `,
		)}

    ${section(
			"features",
			"features",
			"Everything, with the code that uses it",
			cards(FEATURE_CARDS),
		)}

    ${section(
			"transports",
			"transports",
			"Same protocol, three pipes",
			`
      <div class="table-wrap">
        <table>
          <thead><tr><th>transport</th><th>shape</th><th>reach for it when</th></tr></thead>
          <tbody>
            <tr><td>websocket</td><td>bi-directional frames, heartbeat, backpressure ceiling</td><td>the default</td></tr>
            <tr><td>sse</td><td>event-stream down, POST back-channel up, Last-Event-ID replay</td><td>proxies that mangle upgrades</td></tr>
            <tr><td>polling</td><td>three plain HTTP endpoints, per-client queue</td><td>anywhere HTTP works and nothing else does</td></tr>
          </tbody>
        </table>
      </div>
      <div class="grid-2">
        ${code("websocket — runtime agnostic", S.T_WS)}
        ${code("websocket — shaped for Bun.serve", S.T_BUNWS)}
        ${code("server-sent events", S.T_SSE)}
        ${code("http long-polling", S.T_POLL)}
      </div>
      <p class="note">
        Transports hand you handler functions and nothing else — reflectdb ships no HTTP
        server and claims no routes. A custom transport only has to honour one rule:
        <code>send</code> must reject when the frame did not reach the peer, because a
        resolved send is what commits the client's cached result set.
      </p>
    `,
		)}

    ${section(
			"bindings",
			"framework bindings",
			"Hooks, stores, callbacks — or none of them",
			`
      <div class="grid-2">
        ${code("reflectdb/react", S.B_REACT)}
        ${code("reflectdb/svelte", S.B_SVELTE)}
        ${code("reflectdb/vanilla", S.B_VANILLA)}
        ${code("reflectdb/client — works in Node, Bun, Deno, Workers", S.B_CORE)}
      </div>
      <p class="note">
        Every binding is a thin layer over the same client. The typed factories
        (<code>createSyncReact</code>, <code>createSyncSvelte</code>,
        <code>createSyncVanilla</code>) infer row and param types straight from your schema.
      </p>
    `,
		)}

    ${section(
			"architecture",
			"architecture",
			"Where the code lives",
			`
      ${fig(D.modules, "core is the contract; server and client are two implementations of it.")}
      ${fig(D.stateMachine, "The client is a state machine with one recovery path.")}
      <div class="grid-2">
        ${code("client lifecycle, by hand", S.OPTIMISTIC)}
        <p class="note">
          The client persists three things: rows, the pending op queue, and its watermark plus
          HLC state. That is enough to boot offline, keep accepting writes, and rejoin the
          server exactly where it left off — including advancing the clock past any op that
          was queued after the last persist, so a reload can never stamp backwards.
        </p>
      </div>
    `,
		)}

    <footer>
      <div>MIT · Bring your own stack</div>
      <div>
        <a href="${REPO}">github</a> ·
        <a href="${REPO}#api-reference">api reference</a> ·
        <a href="${REPO}#recipes">recipes</a> ·
        <a href="${REPO}/issues">issues</a>
      </div>
    </footer>
  `;

	const rotator = root.querySelector<HTMLElement>("#rotator");
	if (rotator) startRotator(rotator, ROTATING, root.querySelector<HTMLElement>(".period"));

	root.querySelectorAll<HTMLButtonElement>(".copy-btn").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const text = btn.dataset.copy ?? "";
			try {
				await navigator.clipboard.writeText(text);
				const original = btn.textContent;
				btn.textContent = "copied";
				btn.classList.add("copied");
				setTimeout(() => {
					btn.textContent = original;
					btn.classList.remove("copied");
				}, 1200);
			} catch {
				btn.textContent = "press ⌘C";
			}
		});
	});
}

/**
 * Type a word out, hold it, delete it, move to the next one.
 *
 * Starts on the first word already typed, so the headline reads correctly on
 * first paint and the animation begins by erasing rather than by appearing.
 * Always animates, including under prefers-reduced-motion: the headline is the
 * effect. Screen readers get the full list once from the .sr-only span, so the
 * caret is never announced.
 */
function startRotator(el: HTMLElement, words: string[], period?: HTMLElement | null): void {
	if (words.length === 0) return;

	el.textContent = words[0]!;

	const TYPE_MS = 75;
	const DELETE_MS = 32;
	const HOLD_MS = 1900;
	const BETWEEN_MS = 320;

	let index = 0;
	let chars = words[0]!.length;
	let deleting = true;

	const tick = () => {
		const word = words[index]!;
		chars += deleting ? -1 : 1;
		el.textContent = word.slice(0, chars);
		// Hide the full stop between words rather than leaving "engine for ."
		// stranded on screen. visibility, not display, so nothing reflows.
		if (period) period.style.visibility = chars > 0 ? "visible" : "hidden";

		let delay = deleting ? DELETE_MS : TYPE_MS;
		if (!deleting && chars >= word.length) {
			deleting = true;
			delay = HOLD_MS;
		} else if (deleting && chars <= 0) {
			deleting = false;
			index = (index + 1) % words.length;
			delay = BETWEEN_MS;
		}
		setTimeout(tick, delay);
	};

	setTimeout(tick, HOLD_MS);
}
