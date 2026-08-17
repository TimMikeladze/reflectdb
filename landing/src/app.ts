const REPO = "https://github.com/TimMikeladze/reflectdb";

const SERVER_SNIPPET = `<span class="c">// server.ts</span>
<span class="k">import</span> { createSyncServer } <span class="k">from</span> <span class="s">"reflectdb/server"</span>;
<span class="k">import</span> { createWsServerTransport } <span class="k">from</span> <span class="s">"reflectdb/transport/ws"</span>;
<span class="k">import</span> { queries } <span class="k">from</span> <span class="s">"./schema"</span>;

<span class="k">const</span> server = <span class="t">createSyncServer</span>({
  queries,
  transport: <span class="t">createWsServerTransport</span>(),
  serverId: <span class="s">"s1"</span>,
});

server.<span class="t">implement</span>(<span class="s">"todos"</span>, {
  query: () =&gt; [...todos.<span class="t">values</span>()],
  mutate: <span class="k">async</span> (op) =&gt; {
    <span class="k">if</span> (op.type === <span class="s">"delete"</span>) todos.<span class="t">delete</span>(op.rowId);
    <span class="k">else</span> todos.<span class="t">set</span>(op.rowId, { id: op.rowId, ...op.payload });
  },
});`;

const CLIENT_SNIPPET = `<span class="c">// app.tsx</span>
<span class="k">import</span> { SyncProvider, useSync } <span class="k">from</span> <span class="s">"reflectdb/react"</span>;

<span class="k">function</span> <span class="t">Todos</span>() {
  <span class="k">const</span> { rows, insert, update, remove } = <span class="t">useSync</span>(<span class="s">"todos"</span>);
  <span class="c">//      ^? Todo[]   ^? typed mutators</span>

  <span class="k">return</span> rows.<span class="t">map</span>((t) =&gt; (
    &lt;<span class="t">label</span> <span class="n">key</span>={t.id}&gt;
      &lt;<span class="t">input</span>
        <span class="n">type</span>=<span class="s">"checkbox"</span>
        <span class="n">checked</span>={t.done}
        <span class="n">onChange</span>={() =&gt; <span class="t">update</span>(t.id, { done: !t.done })}
      /&gt;
      {t.title}
    &lt;/<span class="t">label</span>&gt;
  ));
}`;

const SCHEMA_SNIPPET = `<span class="c">// schema.ts</span>
<span class="k">import</span> { defineSyncQueries, t } <span class="k">from</span> <span class="s">"reflectdb/core"</span>;

<span class="k">export type</span> <span class="t">Todo</span> = {
  id: <span class="t">string</span>;
  title: <span class="t">string</span>;
  done: <span class="t">boolean</span>;
  createdAt: <span class="t">Date</span>;
};

<span class="k">export const</span> queries = <span class="t">defineSyncQueries</span>({
  todos: {
    row: <span class="t">t</span>&lt;<span class="t">Todo</span>&gt;(),
    conflict: <span class="s">"lww"</span>,
    serverSet: [<span class="s">"createdAt"</span>],
  },
});`;

const VALIDATE_SNIPPET = `<span class="c">// server.ts — payloads are client input</span>
<span class="k">import</span> { MutationError } <span class="k">from</span> <span class="s">"reflectdb/core"</span>;
<span class="k">import</span> { z } <span class="k">from</span> <span class="s">"zod"</span>;

<span class="k">const</span> Todo = z.<span class="t">object</span>({
  title: z.<span class="t">string</span>().<span class="t">min</span>(<span class="n">1</span>).<span class="t">max</span>(<span class="n">200</span>),
  done: z.<span class="t">boolean</span>(),
}).<span class="t">strict</span>();

server.<span class="t">implement</span>(<span class="s">"todos"</span>, {
  query: (ctx, db) =&gt; db.<span class="t">select</span>().<span class="t">from</span>(todos),
  mutate: <span class="k">async</span> (op, ctx, db) =&gt; {
    <span class="c">// updates carry a partial delta, not a whole row</span>
    <span class="k">const</span> shape = op.type === <span class="s">"insert"</span> ? Todo : Todo.<span class="t">partial</span>();
    <span class="k">const</span> parsed = shape.<span class="t">safeParse</span>(op.payload);
    <span class="k">if</span> (!parsed.success) {
      <span class="c">// MutationError maps to a protocol reject reason;</span>
      <span class="c">// a plain throw becomes "server_error"</span>
      <span class="k">throw new</span> <span class="t">MutationError</span>(<span class="s">"outside_shape"</span>, parsed.error.message);
    }
    <span class="k">await</span> <span class="t">write</span>(op.rowId, parsed.data);  <span class="c">// not op.payload</span>
  },
});`;

const DIAGRAM = `┌──────────────┐   writes    ┌──────────────┐   writes    ┌──────────────┐
│  Browser A   │ ──────────▶ │    Server    │ ◀────────── │  Browser B   │
│ (optimistic) │   deltas    │ (authoritive)│   deltas    │ (optimistic) │
│              │ ◀────────── │              │ ──────────▶ │              │
└──────────────┘             └──────────────┘             └──────────────┘
       ▲                            │
       │      offline               ▼
       └────── IndexedDB ───── op log (memory / SQLite / Postgres)`;

const FEATURES: Array<[string, string]> = [
  ["End-to-end types", "Schema defines rows, params, writable fields. Same types flow to server, client, and hooks. No codegen."],
  ["Offline-first", "Optimistic local writes. IndexedDB persistence. Pending ops queue and replay on reconnect."],
  ["Per-column merge", "lww, merge, server-wins, or custom resolvers. HLC ordering means no synchronized clocks needed."],
  ["Bring your own DB", "Drizzle, Kysely, Prisma, raw SQL, a Map. Server hands you db untouched in query and mutate."],
  ["Three transports", "WebSocket, SSE, or HTTP polling. Same protocol, same op log. Works behind any proxy."],
  ["HA with Postgres", "Shared op log between instances. Reconnects resume from HLC watermark across nodes."],
  ["Auto REST", "server.rest() turns the schema into CRUD endpoints. Writes broadcast deltas to live clients."],
  ["Ephemeral channels", "Cursors, presence, typing indicators that bypass the op log. Zero persistence overhead."],
];

export function renderApp(root: HTMLElement): void {
  root.innerHTML = `
    <header>
      <div class="brand">reflectdb</div>
      <nav>
        <a href="#quickstart">quickstart</a>
        <a href="#validation">validation</a>
        <a href="#features">features</a>
        <a href="${REPO}#recipes">recipes</a>
        <a href="${REPO}#api-reference">api</a>
        <a href="${REPO}">github</a>
      </nav>
    </header>

    <section id="hero">
      <h1>real-time sync engine<br/>for <span class="accent">TypeScript</span><span class="cursor"></span></h1>
      <p class="tagline">
        Keep a server-side database in sync with any number of browser clients —
        offline-first, with optimistic local writes, automatic conflict resolution,
        and end-to-end type inference. Bring your own types and your own database.
      </p>

      <div class="cta">
        <a class="btn primary" href="#quickstart">quickstart →</a>
        <a class="btn" href="${REPO}">view on github</a>
      </div>

      <div class="install">
        <code><span class="prompt">$</span>bun add reflectdb</code>
        <button class="copy-btn" data-copy="bun add reflectdb">copy</button>
      </div>
    </section>

    <section id="diagram">
      <h2>architecture</h2>
      <div class="diagram"><pre>${DIAGRAM}</pre></div>
    </section>

    <section id="quickstart">
      <h2>quickstart — 30 lines</h2>
      <div class="code" style="margin-bottom:16px">
        <div class="label">schema.ts — one definition, shared by both sides</div>
        <pre>${SCHEMA_SNIPPET}</pre>
      </div>
      <div class="grid-2">
        <div class="code">
          <div class="label">server.ts</div>
          <pre>${SERVER_SNIPPET}</pre>
        </div>
        <div class="code">
          <div class="label">app.tsx</div>
          <pre>${CLIENT_SNIPPET}</pre>
        </div>
      </div>
    </section>

    <section id="validation">
      <h2>validate what clients send</h2>
      <p class="section-note">
        Schema types are compile-time only. reflectdb checks protocol structure, never
        payload contents — so validate in <code>mutate</code>, with whatever library
        you already use. No dependency, no opinion.
      </p>
      <div class="code">
        <div class="label">server.ts — zod shown, any validator works</div>
        <pre>${VALIDATE_SNIPPET}</pre>
      </div>
    </section>

    <section id="features">
      <h2>features</h2>
      <div class="features">
        ${FEATURES.map(
          ([t, d]) => `
          <div class="feature">
            <h3><span class="dot">▸</span>${escapeHtml(t)}</h3>
            <p>${escapeHtml(d)}</p>
          </div>`,
        ).join("")}
      </div>
    </section>

    <section id="frameworks">
      <h2>framework bindings</h2>
      <div class="features">
        <div class="feature"><h3><span class="dot">▸</span>reflectdb/react</h3><p>SyncProvider, useSync, useRow, useEphemeral, useTotalCount, useLoadMore.</p></div>
        <div class="feature"><h3><span class="dot">▸</span>reflectdb/svelte</h3><p>createSyncStore returns reactive Readables for rows, status, and pendingCount.</p></div>
        <div class="feature"><h3><span class="dot">▸</span>reflectdb/vanilla</h3><p>Callback API for plain JS. Drop into any page, no framework required.</p></div>
        <div class="feature"><h3><span class="dot">▸</span>reflectdb/core</h3><p>Use the typed client directly. Works in Node, Bun, Deno, Workers — anywhere fetch lives.</p></div>
      </div>
    </section>

    <footer>
      <div>MIT · v0.1.0 · Bring your own stack</div>
      <div>
        <a href="${REPO}">github</a> ·
        <a href="${REPO}#api-reference">api</a> ·
        <a href="${REPO}/issues">issues</a>
      </div>
    </footer>
  `;

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
