/**
 * Builds the kanban example for Vercel, emitting the Build Output API directly.
 *
 * Two things force that rather than the zero-config `api/` directory:
 *
 * - The routes have to be BUNDLED. reflectdb's source imports carry explicit
 *   `.ts` extensions (the repo compiles with `allowImportingTsExtensions`), and
 *   Vercel's Node builder rewrites the entry file to `.js` without rewriting
 *   those specifiers — the function boots and dies on `ERR_MODULE_NOT_FOUND`
 *   for a path that was never emitted. Bundling resolves every import ahead of
 *   time and also keeps cold starts down.
 * - Vercel enumerates `api/` from the *source tree*, before the build command
 *   runs. Bundles this script writes there are therefore invisible: the deploy
 *   succeeds and every route 404s. Writing `.vercel/output` ourselves is the
 *   supported way to hand Vercel functions that only exist after a build.
 *
 * Run by the root `vercel.json`'s buildCommand. That root config governs every
 * project built from this repo whose Root Directory is the repository itself —
 * which is why the landing site carries its own `landing/vercel.json`. A
 * `vercel.json` inside a project's Root Directory wins over the one at the
 * repository root; without it, the landing build inherits this file's
 * buildCommand and dies on a missing script.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

const OUTPUT = ".vercel/output";
const EXAMPLE = "examples/kanban";

interface Route {
	/** Source module, exporting one function per HTTP method. */
	entry: string;
	/** Function path under `.vercel/output/functions`, minus the `.func` suffix. */
	out: string;
	/**
	 * Seconds the invocation may run. The SSE route holds its stream for four
	 * minutes (`MAX_STREAM_MS`) and needs room to close it cleanly; a `functions`
	 * block in `vercel.json` cannot say so, because it is validated against the
	 * source tree before `api/` exists.
	 */
	maxDuration: number;
}

const ROUTES: Route[] = [
	{ entry: `${EXAMPLE}/api/sync/events.ts`, out: "api/sync/events", maxDuration: 300 },
	{ entry: `${EXAMPLE}/api/sync/messages.ts`, out: "api/sync/messages", maxDuration: 60 },
];

/**
 * Adapts a route's `GET`/`POST` exports to the Node signature the Build Output
 * API's launcher invokes.
 *
 * The routes are written against web `Request`/`Response` — the same shape
 * Vercel's own `api/` builder gives them — so the launcher's raw
 * `(req, res)` needs the conversion done here rather than inside each route.
 * The response body is piped, never buffered: the SSE route's whole purpose is
 * to deliver each frame as it is produced.
 */
function adapter(entry: string): string {
	return `
import { Readable } from "node:stream";
import * as route from ${JSON.stringify(resolve(entry))};

export default async function handler(req, res) {
	const method = req.method ?? "GET";
	const handle = route[method] ?? (method === "HEAD" ? route.GET : undefined);
	if (!handle) {
		res.writeHead(405, { allow: Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)).join(", ") });
		res.end();
		return;
	}

	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		// HTTP/2 pseudo-headers are not valid Headers entries.
		if (name.startsWith(":") || value === undefined) continue;
		for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
	}

	const host = req.headers.host ?? "localhost";
	const hasBody = method !== "GET" && method !== "HEAD";
	const request = new Request(new URL(req.url ?? "/", \`https://\${host}\`), {
		method,
		headers,
		body: hasBody ? Readable.toWeb(req) : undefined,
		duplex: "half",
	});

	let response;
	try {
		response = await handle(request);
	} catch (error) {
		console.error("[kanban] route threw:", error);
		res.writeHead(500, { "content-type": "text/plain" });
		res.end("Internal Server Error");
		return;
	}

	res.writeHead(response.status, Object.fromEntries(response.headers));
	if (!response.body) {
		res.end();
		return;
	}

	// Node holds the headers back until the first body write, and an SSE stream's
	// first event can be minutes away — the browser's EventSource would sit in
	// \`connecting\` that whole time, so push them out now.
	res.flushHeaders();

	// Destroying the readable on client disconnect is what cancels the web
	// stream underneath it, which is how the SSE route learns to tear its board
	// down — it has no other disconnect signal.
	const body = Readable.fromWeb(response.body);
	res.on("close", () => body.destroy());
	body.pipe(res);
}
`;
}

await rm(OUTPUT, { recursive: true, force: true });
await mkdir(`${OUTPUT}/functions`, { recursive: true });

for (const route of ROUTES) {
	const dir = `${OUTPUT}/functions/${route.out}.func`;
	const entry = `${OUTPUT}/entries/${route.out.replaceAll("/", "-")}.js`;
	await Bun.write(entry, adapter(route.entry));

	const result = await Bun.build({
		entrypoints: [entry],
		target: "node",
		format: "esm",
		// Not minified: a stack trace from a serverless function is the only
		// debugging surface there is, and the bundle is a few hundred KB.
		minify: false,
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error(`Failed to bundle ${route.entry}`);
	}

	await Bun.write(`${dir}/index.mjs`, await result.outputs[0]!.text());
	await Bun.write(
		`${dir}/.vc-config.json`,
		`${JSON.stringify(
			{
				runtime: "nodejs22.x",
				handler: "index.mjs",
				launcherType: "Nodejs",
				// The routes build their own `Request`, so the body-parsing and
				// `res.json()` helpers would only get in the way of streaming.
				shouldAddHelpers: false,
				// Without this the platform buffers the whole response, which for a
				// held SSE stream means delivering every event at once, four minutes
				// late.
				supportsResponseStreaming: true,
				maxDuration: route.maxDuration,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`bundled ${route.entry} -> ${dir}`);
}

await rm(`${OUTPUT}/entries`, { recursive: true, force: true });

await $`bun install`.cwd(EXAMPLE).quiet();
await $`bunx vite build`.cwd(EXAMPLE);
await cp(`${EXAMPLE}/dist`, `${OUTPUT}/static`, { recursive: true });

// `handle: filesystem` runs before the fallback, so the functions above and the
// hashed assets win; anything else is the single-page app's entry.
await Bun.write(
	`${OUTPUT}/config.json`,
	`${JSON.stringify(
		{
			version: 3,
			routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index.html" }],
		},
		null,
		2,
	)}\n`,
);
console.log(`wrote ${OUTPUT}/config.json`);
