/**
 * Check the things about the presence service that only a deploy would
 * otherwise catch.
 *
 * The root type-check covers `services/**`, but it resolves imports against
 * the *root* node_modules — so a dependency the service forgot to declare in
 * its own package.json still type-checks at the root and then fails on the
 * platform, which installs from `services/presence/package.json` alone. And
 * nothing type-checks `vercel.json` at all: a `functions` key naming a file
 * that has since moved does not error, it silently stops applying, which for
 * the stream handler means losing its `maxDuration` and having every stream
 * cut off mid-frame at the default ceiling.
 *
 * Run from the repo root: `bun scripts/verify-presence.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SERVICE = join(ROOT, "services", "presence");
const API = join(SERVICE, "api");

const problems: string[] = [];

function fail(message: string): void {
	problems.push(message);
}

/** Every `.ts` file under `api/`, which is exactly the set Vercel turns into functions. */
function handlerFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...handlerFiles(path));
		} else if (entry.endsWith(".ts")) {
			found.push(path);
		}
	}
	return found;
}

// ── vercel.json ─────────────────────────────────────────────────────────

const configPath = join(SERVICE, "vercel.json");
if (!existsSync(configPath)) {
	fail("services/presence/vercel.json is missing");
}

let config: { functions?: Record<string, unknown>; rewrites?: { destination?: string }[] } = {};
try {
	config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
	fail(`vercel.json does not parse: ${err instanceof Error ? err.message : String(err)}`);
}

// A `functions` key is a path relative to the project root, and a stale one is
// silent — the config simply stops applying to anything.
for (const pattern of Object.keys(config.functions ?? {})) {
	if (pattern.includes("*")) continue;
	if (!existsSync(join(SERVICE, pattern))) {
		fail(`vercel.json "functions" names ${pattern}, which does not exist`);
	}
}

// A rewrite pointing at a route that no longer exists 404s instead of erroring.
for (const rewrite of config.rewrites ?? []) {
	const destination = rewrite.destination;
	if (!destination?.startsWith("/api/")) continue;
	if (!existsSync(join(SERVICE, `${destination.slice(1)}.ts`))) {
		fail(`vercel.json rewrites to ${destination}, which has no handler file`);
	}
}

// ── handlers ────────────────────────────────────────────────────────────

if (!existsSync(API)) {
	fail("services/presence/api is missing — the service would deploy with no routes");
} else {
	const handlers = handlerFiles(API);
	if (handlers.length === 0) fail("no handlers found under services/presence/api");

	for (const file of handlers) {
		const source = readFileSync(file, "utf8");
		// Vercel's Node runtime invokes the default export. A handler without one
		// builds cleanly and then 500s on every request.
		if (!/export\s+default\s/.test(source)) {
			fail(`${relative(ROOT, file)} has no default export, so Vercel has nothing to invoke`);
		}
	}
}

// ── dependencies ────────────────────────────────────────────────────────

const pkgPath = join(SERVICE, "package.json");
const pkg: { dependencies?: Record<string, string> } = JSON.parse(readFileSync(pkgPath, "utf8"));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));

/**
 * Comments come out first. This file's own prose contains the words `from
 * "any page does"`, and a bare `from "…"` scan happily reports that as an
 * undeclared dependency.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Bare specifiers imported anywhere in the service, minus node: builtins and relatives. */
const imported = new Set<string>();
for (const file of [...handlerFiles(SERVICE).filter((f) => !f.includes("node_modules"))]) {
	const source = stripComments(readFileSync(file, "utf8"));
	for (const match of source.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g)) {
		const specifier = match[1]!;
		if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
		// Scoped packages keep two segments; everything else keeps one.
		const name = specifier.startsWith("@")
			? specifier.split("/").slice(0, 2).join("/")
			: specifier.split("/")[0]!;
		imported.add(name);
	}
}

for (const name of imported) {
	if (!declared.has(name)) {
		fail(
			`services/presence imports "${name}" but does not declare it in its package.json — ` +
				`the root install hides this, the platform install does not`,
		);
	}
}

// ── report ──────────────────────────────────────────────────────────────

if (problems.length > 0) {
	console.error("presence service verification failed:\n");
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

console.log("presence service OK: vercel.json, handlers and dependencies all check out");
