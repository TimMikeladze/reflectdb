import * as D from "./diagrams.ts";
import { escapeHtml, highlight } from "./highlight.ts";
import { mountPresenceDemo } from "./presence-demo.ts";
import * as S from "./snippets.ts";

const REPO = "https://github.com/TimMikeladze/reflectdb";
const TETRIS_DEMO = "https://reflectdb-tetris.fly.dev/";
const WHITEBOARD_DEMO = "https://reflectdb-whiteboard.fly.dev/";
const KANBAN_DEMO = "https://reflectdb-kanban.vercel.app/";
const PRESENCE_SERVICE = `${REPO}/tree/main/services/presence`;

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
		title: "No database at all",
		desc: "Run a room on an S3-compatible bucket — no Postgres, no SQLite, no volume. State is authoritative in memory; the bucket is durability.",
		src: S.F_OBJECT,
	},
	{
		title: "Runs serverless",
		desc: "Drop the writer lease, race on a compare-and-swap, and answer each POST with the replies it produced. Vercel, Lambda or Workers.",
		src: S.F_SERVERLESS,
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
      <div class="bar">
      <div class="brand">reflectdb<span class="beta-wrap">
        <button class="beta-pill" type="button" aria-describedby="beta-tip">beta</button>
        <span class="beta-tip" id="beta-tip" role="tooltip">
          reflectdb is pre-1.0 and under active development. The API can still change
          between minor releases, and it has not been hardened for production traffic.
          Pin an exact version, and <a href="${REPO}/issues">tell us what breaks</a>.
        </span>
      </span></div>
      <button class="menu-btn" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="Open menu">menu</button>
      <nav id="site-nav">
        <a href="#overview">overview</a>
        <a href="#demos">demos</a>
        <a href="#how">how it works</a>
        <a href="#quickstart">quickstart</a>
        <a href="#concepts">concepts</a>
        <a href="#features">features</a>
        <a href="#transports">transports</a>
      </nav>
      <button class="theme-btn" type="button" aria-label="Switch theme"></button>
      <a class="gh" href="${REPO}" aria-label="reflectdb on GitHub">
        <svg class="gh-icon" viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.19c0 .21.15.46.55.38A8 8 0 0 0 8 0Z"/></svg>
        <span class="gh-label">github</span>
      </a>
      </div>
    </header>

    <div class="page">
    <section id="hero">
      <div class="hero-copy">
        <h1>real-time sync engine<br/>for <span class="accent" id="rotator" aria-hidden="true">${ROTATING[0]}</span><span class="period">.</span><span class="sr-only">${ROTATING.join(", ")}</span><span class="cursor"></span></h1>
        <p class="tagline">
          Keep a server-side database in sync with any number of browser clients —
          offline-first, with optimistic local writes, automatic conflict resolution,
          and end-to-end type inference. Bring your own types and your own database.
        </p>

        <div class="cta">
          <a class="btn primary" href="#overview">how it works →</a>
          <a class="btn" href="#demos">live demos</a>
          <a class="btn" href="#quickstart">quickstart</a>
          <a class="btn" href="${REPO}">view on github</a>
        </div>

        <div class="install">
          <code><span class="prompt">$</span>bun add reflectdb</code>
          <button class="copy-btn" data-copy="bun add reflectdb">copy</button>
        </div>
      </div>

      <!-- The same four demos the page ends up arguing for, at a glance. Each
           is a static miniature rather than a running instance: the hero must
           paint immediately, and the live one is a screenful away in #demos. -->
      <div class="hero-minis">
        <a class="hero-mini" href="#demos">
          <svg viewBox="0 0 96 52" aria-hidden="true">
            <g class="mini-grid">
              <path d="M16 0V52M32 0V52M48 0V52M64 0V52M80 0V52" />
              <path d="M0 13H96M0 26H96M0 39H96" />
            </g>
            <g class="mini-cursor a" transform="translate(24 14)">
              <path d="M0 0l9 3.5-3.5 1.5-1.5 3.5z" /><rect x="7" y="6" width="20" height="8" rx="2" />
            </g>
            <g class="mini-cursor b" transform="translate(56 30)">
              <path d="M0 0l9 3.5-3.5 1.5-1.5 3.5z" /><rect x="7" y="6" width="16" height="8" rx="2" />
            </g>
          </svg>
          <span class="hero-mini-label"><strong>presence</strong><em>live on this page</em></span>
        </a>

        <a class="hero-mini" href="${TETRIS_DEMO}">
          <svg viewBox="0 0 96 52" aria-hidden="true">
            <rect class="mini-well" x="30" y="2" width="36" height="48" rx="1" />
            <g class="mini-piece">
              <rect x="42" y="10" width="6" height="6" /><rect x="48" y="10" width="6" height="6" />
              <rect x="48" y="16" width="6" height="6" /><rect x="54" y="16" width="6" height="6" />
            </g>
            <g class="mini-stack">
              <rect x="30" y="44" width="6" height="6" /><rect x="36" y="44" width="6" height="6" />
              <rect x="48" y="44" width="6" height="6" /><rect x="54" y="44" width="6" height="6" />
              <rect x="60" y="44" width="6" height="6" /><rect x="30" y="38" width="6" height="6" />
              <rect x="42" y="38" width="6" height="6" /><rect x="60" y="38" width="6" height="6" />
            </g>
          </svg>
          <span class="hero-mini-label"><strong>tetris</strong><em>multiplayer, one well each</em></span>
        </a>

        <a class="hero-mini" href="${WHITEBOARD_DEMO}">
          <svg viewBox="0 0 96 52" aria-hidden="true">
            <g class="mini-ink">
              <path class="ink-a" d="M22 40V22l12-9 12 9v18" />
              <path class="ink-a" d="M16 40h36" />
              <circle class="ink-b" cx="70" cy="18" r="7" />
              <path class="ink-c" d="M10 46c8-4 16-4 24 0s16 4 24 0 16-4 28 1" />
            </g>
            <g class="mini-cursor b" transform="translate(52 24)">
              <path d="M0 0l9 3.5-3.5 1.5-1.5 3.5z" /><rect x="7" y="6" width="16" height="8" rx="2" />
            </g>
          </svg>
          <span class="hero-mini-label"><strong>whiteboard</strong><em>draw together, guess in chat</em></span>
        </a>

        <a class="hero-mini" href="${KANBAN_DEMO}">
          <svg viewBox="0 0 96 52" aria-hidden="true">
            <g class="mini-board">
              <rect x="5" y="6" width="27" height="40" rx="2" />
              <rect x="34.5" y="6" width="27" height="40" rx="2" />
              <rect x="64" y="6" width="27" height="40" rx="2" />
            </g>
            <g class="mini-card">
              <rect x="9" y="11" width="19" height="7" rx="1.5" />
              <rect x="9" y="22" width="19" height="7" rx="1.5" />
              <rect x="68" y="11" width="19" height="7" rx="1.5" />
            </g>
            <g class="mini-card moving">
              <rect x="38.5" y="11" width="19" height="7" rx="1.5" />
            </g>
          </svg>
          <span class="hero-mini-label"><strong>kanban</strong><em>no database, just a bucket</em></span>
        </a>
      </div>
    </section>

    ${section(
			"overview",
			"the shape of it",
			"Five pictures before any code",
			`
      <p class="note">
        reflectdb keeps a server-side database and any number of browser copies of it in
        agreement. Everything below is that sentence, drawn — the mechanism, the gate names
        and the code all come after.
      </p>

      <h3 class="sub">Where everything sits</h3>
      ${fig(
				D.topology,
				"Clients hold an optimistic copy. The server owns your database and the op log, and is the only thing that decides what a write means.",
			)}

      <h3 class="sub">A write reaches the screen before it reaches the server</h3>
      ${fig(
				D.latency,
				"The local row changes at 0 ms. The round trip only confirms it — and if the server refuses, the row reverts to exactly what it was.",
			)}

      <h3 class="sub">Ordering across machines, trusting no clock</h3>
      ${fig(
				D.clock,
				"A hybrid logical clock packs into a zero-padded string, so deciding which of two writes happened first costs one string comparison.",
			)}

      <h3 class="sub">Two people edit the same row at the same moment</h3>
      ${fig(
				D.policies,
				"You answer that per table, in one word — or with a function when the answer is only yours to write.",
			)}

      <h3 class="sub">Offline is a very long round trip</h3>
      ${fig(
				D.offlineQueue,
				"Writes keep landing in a queue that outlives the tab. Reconnecting replays it, and every op id is reserved exactly once.",
			)}
    `,
		)}

    ${section(
			"demos",
			"live demos",
			"See the sync engine move",
			`
      <article class="demo-feature">
        <div class="demo-copy">
          <div class="demo-status"><span></span>deployed on Vercel · running right now</div>
          <h4>Presence, live on this page</h4>
          <p>
            The three demos below are somewhere else. This one is here: the panel is connected
            to the public presence service, publishing your pointer and drawing everyone
            else's. Open this page in a second tab and the two see each other.
          </p>
          <ul class="demo-facts">
            <li>a snapshot on join — late arrivals see who is already there</li>
            <li>server-sent events down, plain POSTs up — no sockets anywhere</li>
            <li>state lives in Postgres, so a room spans every instance</li>
          </ul>
          <div class="demo-actions">
            <a class="btn primary" href="${PRESENCE_SERVICE}">read the service →</a>
            <a class="btn" href="${PRESENCE_SERVICE}/client.ts">view the client</a>
          </div>
          <p class="demo-hint">
            Your cursor is shared with everyone reading this page, and stored nowhere.
          </p>
        </div>

        <div class="demo-preview demo-live" id="presence-demo">
          <div class="demo-chrome">
            <span class="demo-chrome-dot"></span>
            <span>reflectdb-presence.vercel.app</span>
            <span class="demo-synced" data-presence-state>connecting</span>
          </div>
          <div class="presence-surface" data-presence-surface>
            <p class="presence-invite" data-presence-invite>move your cursor in here</p>
            <div class="presence-peers" data-presence-peers></div>
            <div class="presence-ghosts" aria-hidden="true">
              <div class="presence-cursor" style="--peer-color: #6ea8ff; left: 30%; top: 38%">
                <svg viewBox="0 0 14 16"><path d="M0 0l13 5-5 2-2 5z" /></svg><span>clever lynx</span>
              </div>
              <div class="presence-cursor" style="--peer-color: #ffb86b; left: 62%; top: 64%">
                <svg viewBox="0 0 14 16"><path d="M0 0l13 5-5 2-2 5z" /></svg><span>bold otter</span>
              </div>
            </div>
          </div>
          <div class="demo-preview-footer"><span class="presence-tagline">real visitors · real cursors</span><span class="presence-roster" data-presence-roster></span><strong data-presence-count>presence is loading</strong></div>
        </div>
      </article>

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

      <article class="demo-feature">
        <div class="demo-copy">
          <div class="demo-status"><span></span>deployed on fly.io · wakes on demand</div>
          <h4>Collaborative whiteboard</h4>
          <p>
            A shared canvas with live peer cursors and chat, plus a Pictionary mode where
            the server picks the word, runs the round clock, and keeps the answer off every
            guesser's wire.
          </p>
          <ul class="demo-facts">
            <li>one row per stroke — no line overwrites another</li>
            <li>only the drawer's tab receives the word</li>
            <li>guest sign-in, no account needed</li>
            <li>rooms and their drawings are deleted 30 minutes after creation</li>
          </ul>
          <div class="demo-actions">
            <a class="btn primary" href="${WHITEBOARD_DEMO}">open the demo →</a>
            <a class="btn" href="${REPO}/tree/main/examples/whiteboard">view source</a>
          </div>
          <p class="demo-hint">The first load may take a moment while the Fly Machine starts.</p>
        </div>

        <a class="demo-preview" href="${WHITEBOARD_DEMO}" aria-label="Open the collaborative whiteboard demo">
          <div class="demo-chrome">
            <span class="demo-chrome-dot"></span>
            <span>reflectdb-whiteboard.fly.dev</span>
            <span class="demo-synced">synced</span>
          </div>
          <div class="demo-board">
            <div class="demo-hud">
              <span class="demo-hud-word"><small>word · 5 letters</small><strong>_ _ _ _ _</strong></span>
              <span class="demo-hud-timer">0:42</span>
            </div>
            <svg viewBox="0 0 340 210" role="img" aria-label="A shared whiteboard sketch with two peer cursors drawing at once">
              <g class="demo-ink">
                <path class="ink-1" d="M96 158V96l34-24 34 24v62" />
                <path class="ink-1" d="M84 158h92" />
                <path class="ink-2" d="M120 158v-30h20v30" />
                <path class="ink-3" d="M104 104h16v16h-16zM140 104h16v16h-16z" />
                <circle class="ink-4" cx="214" cy="74" r="18" />
                <path class="ink-4" d="M214 48v-8M214 100v8M240 74h8M188 74h-8M231 57l6-6M197 91l-6 6M231 91l6 6M197 57l-6-6" />
                <path class="ink-5" d="M46 172c22-9 44-9 66 0s44 9 66 0 44-9 66 0 40 8 50 3" />
              </g>
              <g class="demo-peer peer-a" transform="translate(163 88)">
                <path d="M0 0l13 5-5 2-2 5z" />
                <rect x="10" y="9" width="34" height="15" rx="4" />
                <text x="27" y="20">mia</text>
              </g>
              <g class="demo-peer peer-b" transform="translate(238 132)">
                <path d="M0 0l13 5-5 2-2 5z" />
                <rect x="10" y="9" width="36" height="15" rx="4" />
                <text x="28" y="20">sam</text>
              </g>
            </svg>
            <div class="demo-chat">
              <span class="demo-chat-line"><em>sam</em>is it a barn?</span>
              <span class="demo-chat-line correct"><em>mia</em>🎉 guessed in 33s (+94)</span>
            </div>
          </div>
          <div class="demo-preview-footer"><span>draw together · guess in chat</span><strong>open →</strong></div>
        </a>
      </article>

      <article class="demo-feature">
        <div class="demo-copy">
          <div class="demo-status"><span></span>deployed on vercel · tigris bucket · no database</div>
          <h4>Multiplayer kanban</h4>
          <p>
            A shared board with no database behind it. Every card, every op and the log itself
            live in object storage — no Postgres, no SQLite, no volume — on serverless functions
            that keep nothing between requests.
          </p>
          <ul class="demo-facts">
            <li>state is authoritative in memory; the bucket is durability</li>
            <li>no writer lease — instances race on a compare-and-swap and retry</li>
            <li>one PUT per batch, self-clocking; an idle board costs nothing</li>
            <li>works on S3, R2, Tigris, MinIO or GCS</li>
          </ul>
          <div class="demo-actions">
            <a class="btn primary" href="${KANBAN_DEMO}">open the demo →</a>
            <a class="btn" href="${REPO}/tree/main/examples/kanban">view source</a>
          </div>
          <p class="demo-hint">Open two tabs to drag cards against yourself. Deploy your own with <code>vercel deploy</code> and a bucket.</p>
        </div>

        <a class="demo-preview" href="${KANBAN_DEMO}" aria-label="Open the multiplayer kanban demo">
          <div class="demo-chrome">
            <span class="demo-chrome-dot"></span>
            <span>reflectdb-kanban.vercel.app</span>
            <span class="demo-synced">durable</span>
          </div>
          <div class="demo-board">
            <svg class="kanban-svg" viewBox="0 0 420 180" role="img" aria-label="A kanban board with three columns, one card moving between them, and the object-storage keys each write produces">
              <g class="kanban-col">
                <rect x="8" y="8" width="124" height="164" rx="8" />
                <rect x="148" y="8" width="124" height="164" rx="8" />
                <rect x="288" y="8" width="124" height="164" rx="8" />
              </g>
              <g class="kanban-label">
                <text x="20" y="27">todo</text>
                <text x="160" y="27">doing</text>
                <text x="300" y="27">done</text>
              </g>
              <g class="kanban-card">
                <rect x="20" y="38" width="100" height="26" rx="5" />
                <rect x="20" y="72" width="100" height="26" rx="5" />
                <rect x="20" y="106" width="100" height="26" rx="5" />
                <rect x="300" y="38" width="100" height="26" rx="5" />
                <rect x="300" y="72" width="100" height="26" rx="5" />
              </g>
              <g class="kanban-card moving">
                <rect x="160" y="38" width="100" height="26" rx="5" />
              </g>
            </svg>
            <div class="kanban-keys">
              <span class="kanban-key"><em>PUT</em>wal/writer-a-7.jsonl<small>1 batch · 3 ops</small></span>
              <span class="kanban-key committed"><em>CAS</em>_manifest<small>commitSeq 41 ✓</small></span>
            </div>
          </div>
          <div class="demo-preview-footer"><span>one bucket · zero servers</span><strong>open →</strong></div>
        </a>
      </article>
    `,
		)}

    ${section(
			"how",
			"how it works",
			"One write, end to end",
			`
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

      <h3 class="sub">Or no database at all</h3>
      ${fig(
				D.objectStorage,
				"Swap the op log for a bucket and the read path never changes — it was already memory.",
			)}
      <div class="grid-2">
        ${code("server.ts", S.F_OBJECT)}
        <p class="note">
          <code>createObjectStorage</code> makes an S3-compatible bucket the only durable
          store — AWS, R2, Tigris, MinIO or GCS. Reads never leave the process, writes
          group-commit one object per batch, and the flush loop is self-clocking, so there is
          no interval to tune and an idle room issues nothing at all. The trade is one writer
          per room, so route a room to one instance — or drop the lease with
          <code>concurrency: "optimistic"</code>, let instances race on the manifest CAS, and
          call <code>refresh()</code> before a read that has to be current.
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
            <tr><td>sse</td><td>event-stream down, POST back-channel up, Last-Event-ID replay</td><td>proxies that mangle upgrades — and serverless, in <code>serverless</code> mode</td></tr>
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
      <p class="note">
        On a serverless platform the POST and the held stream are two different invocations,
        so a reply can never reach a stream that process does not own.
        <code>serverless: true</code> on both halves of the SSE transport returns each POST's
        replies in its own response, and leaves the stream doing the one thing it still can:
        pushing other clients' changes. A deployed example is
        <a href="${REPO}/tree/main/examples/kanban">examples/kanban</a>.
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
      <div>MIT · Beta, pre-1.0 · Bring your own stack</div>
      <div>
        <a href="${REPO}">github</a> ·
        <a href="${REPO}#api-reference">api reference</a> ·
        <a href="${REPO}#recipes">recipes</a> ·
        <a href="${REPO}/issues">issues</a>
      </div>
    </footer>
    </div>
  `;

	const rotator = root.querySelector<HTMLElement>("#rotator");
	if (rotator) startRotator(rotator, ROTATING, root.querySelector<HTMLElement>(".period"));

	const header = root.querySelector<HTMLElement>("header");
	const menuBtn = root.querySelector<HTMLButtonElement>(".menu-btn");
	if (header && menuBtn) wireMenu(header, menuBtn);

	const themeBtn = root.querySelector<HTMLButtonElement>(".theme-btn");
	if (themeBtn) wireTheme(themeBtn);

	const betaWrap = root.querySelector<HTMLElement>(".beta-wrap");
	if (betaWrap) wireBetaTip(betaWrap);

	const presenceDemo = root.querySelector<HTMLElement>("#presence-demo");
	if (presenceDemo) mountPresenceDemo(presenceDemo);

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
 * The pre-1.0 warning, folded into the wordmark's badge. Hover and keyboard
 * focus are handled in CSS; this only adds what CSS cannot do — a tap target
 * for touch, where there is no hover, and Escape to dismiss. `pinned` keeps the
 * tooltip up after a tap until something else is touched, so the link inside it
 * can be reached.
 */
function wireBetaTip(wrap: HTMLElement): void {
	const button = wrap.querySelector<HTMLButtonElement>(".beta-pill");
	if (!button) return;

	const setPinned = (pinned: boolean): void => {
		wrap.classList.toggle("pinned", pinned);
	};

	button.addEventListener("click", (event) => {
		event.stopPropagation();
		setPinned(!wrap.classList.contains("pinned"));
	});

	document.addEventListener("click", (event) => {
		if (!wrap.contains(event.target as Node)) setPinned(false);
	});

	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		setPinned(false);
		if (wrap.contains(document.activeElement)) button.blur();
	});
}

type Theme = "light" | "dark";

/** Shared with the pre-paint script in index.html — change both together. */
const THEME_KEY = "reflectdb-theme";

/** Kept level with --bg in style.css so browser chrome matches the page. */
const THEME_BG: Record<Theme, string> = { dark: "#0a0a0b", light: "#ffffff" };

const SUN_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="3.1" fill="currentColor"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 .8v1.9M8 13.3v1.9M15.2 8h-1.9M2.7 8H.8M13.1 13.1l-1.35-1.35M4.25 4.25 2.9 2.9M2.9 13.1l1.35-1.35M11.75 4.25 13.1 2.9"/></g></svg>`;

const MOON_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13.7 10.1A5.9 5.9 0 0 1 6.2 2.5a6.5 6.5 0 1 0 7.5 7.6Z"/></svg>`;

/**
 * Light/dark, in three states: no data-theme follows the OS, and an explicit
 * pick writes data-theme plus localStorage so it survives a reload. The pinned
 * value is re-applied before first paint by the inline script in index.html —
 * by the time this runs the page is already the right colour, and all that is
 * left is to label the button and keep it in step.
 *
 * The button shows where a click *goes*, not where you are: a sun while dark.
 */
function wireTheme(button: HTMLButtonElement): void {
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	const root = document.documentElement;

	const resolve = (): Theme => {
		const pinned = root.dataset.theme;
		if (pinned === "light" || pinned === "dark") return pinned;
		return media.matches ? "dark" : "light";
	};

	const paint = (theme: Theme): void => {
		const next = theme === "dark" ? "light" : "dark";
		button.innerHTML = theme === "dark" ? SUN_ICON : MOON_ICON;
		button.setAttribute("aria-label", `Switch to ${next} theme`);
		button.setAttribute("title", `Switch to ${next} theme`);
		const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
		if (meta) meta.content = THEME_BG[theme];
	};

	paint(resolve());

	button.addEventListener("click", () => {
		const next: Theme = resolve() === "dark" ? "light" : "dark";
		root.dataset.theme = next;
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {
			// Private mode, or storage disabled. The pick still holds for this page.
		}
		paint(next);
	});

	// Nothing is pinned until the button is pressed, so until then the OS is in
	// charge and the icon has to follow it.
	media.addEventListener("change", () => {
		if (!root.dataset.theme) paint(resolve());
	});
}

/**
 * The narrow-screen menu: the same nav links, collapsed behind one button.
 *
 * The links stay in the DOM either way — the media query decides whether they
 * sit in the bar or in a dropdown — so there is one nav to keep in sync and the
 * markup reads the same to a crawler at any width. `open` lives on the header so
 * the button and the panel can be styled from a single class.
 */
function wireMenu(header: HTMLElement, button: HTMLButtonElement): void {
	const setOpen = (open: boolean): void => {
		header.classList.toggle("open", open);
		button.setAttribute("aria-expanded", String(open));
		button.setAttribute("aria-label", open ? "Close menu" : "Open menu");
	};

	button.addEventListener("click", (event) => {
		event.stopPropagation();
		setOpen(!header.classList.contains("open"));
	});

	// Following a link leaves the panel covering the section it jumped to, so
	// close on any nav click. Clicks elsewhere and Escape close it too.
	header.querySelector("nav")?.addEventListener("click", () => setOpen(false));
	document.addEventListener("click", (event) => {
		if (!header.contains(event.target as Node)) setOpen(false);
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") setOpen(false);
	});

	// Widening past the breakpoint puts the links back in the bar; the open
	// state would otherwise linger and re-appear on the next narrow resize.
	window.matchMedia("(min-width: 761px)").addEventListener("change", (event) => {
		if (event.matches) setOpen(false);
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
