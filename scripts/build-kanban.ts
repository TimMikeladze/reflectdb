/**
 * Builds the kanban example for Vercel.
 *
 * The API routes are BUNDLED rather than handed to Vercel as TypeScript.
 * reflectdb's source imports carry explicit `.ts` extensions (the repo compiles
 * with `allowImportingTsExtensions`), and Vercel's Node builder rewrites the
 * entry file to `.js` without rewriting those specifiers — so the function
 * boots and immediately dies on `ERR_MODULE_NOT_FOUND` for a `.ts` path that
 * was never emitted. Bundling resolves every import ahead of time and hands
 * Vercel one self-contained file per route, which also keeps cold starts down.
 *
 * Run by `vercel.kanban.json`'s buildCommand, before the function build phase,
 * so the generated files are on disk when Vercel scans `api/`. That config is
 * NOT named `vercel.json` on purpose: a root `vercel.json` would also govern
 * the landing-site project built from this repo. Deploy with
 * `vercel deploy --prod -A vercel.kanban.json`.
 */

import { mkdir, rm } from "node:fs/promises";
import { $ } from "bun";

const ROUTES = [
	{ entry: "examples/kanban/api/sync/events.ts", out: "api/sync/events.js" },
	{ entry: "examples/kanban/api/sync/messages.ts", out: "api/sync/messages.js" },
];

await rm("api", { recursive: true, force: true });
await mkdir("api/sync", { recursive: true });

for (const route of ROUTES) {
	const result = await Bun.build({
		entrypoints: [route.entry],
		target: "node",
		format: "esm",
		// Not minified: a stack trace from a serverless function is the only
		// debugging surface there is, and the bundle is a few tens of KB.
		minify: false,
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error(`Failed to bundle ${route.entry}`);
	}
	await Bun.write(route.out, await result.outputs[0]!.text());
	console.log(`bundled ${route.entry} -> ${route.out}`);
}

await $`bun install`.cwd("examples/kanban").quiet();
await $`bunx vite build`.cwd("examples/kanban");
