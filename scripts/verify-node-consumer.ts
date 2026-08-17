/**
 * Installs the packed tarball into a throwaway Node project and proves it works
 * there — the thing every other check in this repo cannot see.
 *
 * `bun test`, `bun run type-check` and `bun run verify:exports` all execute
 * under Bun, against the working tree. None of them observe what a Node
 * consumer observes: resolution through the published "exports" map by package
 * name, declaration files read without Bun's ambient types, and module
 * evaluation on a runtime where `bun:sqlite` does not exist. Every packaging
 * regression this repo has shipped lived in exactly that gap — a top-level
 * `bun:sqlite` import that made `reflectdb/server` unloadable on Node, a
 * `bun:sqlite` type reference in the emitted d.ts, a `Buffer` in an exported
 * signature, an entry point built but never listed in "exports".
 *
 * Run after `bun run build`. Requires `node` and `npm` on PATH.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");
const errors: string[] = [];

/** Subpaths that ship a file directly rather than a built entry point. */
const PASSTHROUGH = new Set(["./package.json"]);

const subpaths = Object.keys(pkg.exports as Record<string, unknown>).filter(
	(s) => !PASSTHROUGH.has(s),
);
/** "./core" → "reflectdb/core", "." → "reflectdb" — what a real consumer writes. */
const specifiers = subpaths.map((s) => (s === "." ? pkg.name : `${pkg.name}/${s.slice(2)}`));

function run(cmd: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
	const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const decode = (b: Uint8Array) => new TextDecoder().decode(b);
	return { ok: proc.exitCode === 0, stdout: decode(proc.stdout), stderr: decode(proc.stderr) };
}

const workdir = mkdtempSync(join(tmpdir(), "reflectdb-node-consumer-"));

try {
	// ── Pack ────────────────────────────────────────────────────────────────
	// The same command release.yml publishes, so what we test is what ships —
	// including whatever "files" does or does not let through.
	const packed = run(["bun", "pm", "pack", "--destination", workdir], root);
	if (!packed.ok) {
		throw new Error(`bun pm pack failed:\n${packed.stderr || packed.stdout}`);
	}
	const tarball = [...new Bun.Glob("*.tgz").scanSync({ cwd: workdir })][0];
	if (!tarball) throw new Error(`no tarball produced in ${workdir}`);

	// ── Install into a bare Node project ────────────────────────────────────
	const consumer = join(workdir, "consumer");
	await Bun.write(
		join(consumer, "package.json"),
		JSON.stringify({
			name: "reflectdb-node-consumer",
			version: "0.0.0",
			private: true,
			type: "module",
		}),
	);
	// Optional peers are installed because they are exactly what makes the react
	// and drizzle entry points resolvable — omitting them would test less, not more.
	const install = run(
		[
			"npm",
			"install",
			"--no-audit",
			"--no-fund",
			join(workdir, tarball),
			"react",
			"@types/react",
			"drizzle-orm",
		],
		consumer,
	);
	if (!install.ok) {
		throw new Error(`npm install failed:\n${install.stderr || install.stdout}`);
	}

	// ── Runtime: every subpath must evaluate on Node ─────────────────────────
	// `import()` per specifier, so a failure names the subpath that broke rather
	// than aborting the whole file at the first bad one.
	await Bun.write(
		join(consumer, "smoke.mjs"),
		`const specifiers = ${JSON.stringify(specifiers)};
const failures = [];
for (const s of specifiers) {
	try {
		const m = await import(s);
		if (Object.keys(m).length === 0) failures.push(s + ": imported but exports nothing");
	} catch (err) {
		failures.push(s + ": " + err.message);
	}
}

// bun:sqlite has no Node equivalent, so createSqliteStorage is expected to fail
// here — but it must fail with the documented message at call time, not by
// making the whole of reflectdb/server unloadable. That regression has shipped before.
try {
	const { createSqliteStorage } = await import("${pkg.name}/server");
	createSqliteStorage({});
	failures.push("createSqliteStorage: expected a throw on Node, got none");
} catch (err) {
	if (!err.message.includes("requires the Bun runtime")) {
		failures.push("createSqliteStorage: threw the wrong error on Node: " + err.message);
	}
}

for (const f of failures) console.log("FAIL " + f);
console.log("checked " + specifiers.length + " subpaths on node " + process.version);
process.exit(failures.length > 0 ? 1 : 0);
`,
	);
	const smoke = run(["node", "smoke.mjs"], consumer);
	for (const line of smoke.stdout.split("\n")) {
		if (line.startsWith("FAIL ")) errors.push(`node runtime (esm): ${line.slice(5)}`);
	}
	if (!smoke.ok && errors.length === 0) {
		errors.push(`node runtime (esm): smoke test exited ${smoke.stdout}${smoke.stderr}`.trim());
	}

	// ── Runtime: the same subpaths under require() ───────────────────────────
	// The CJS build is a separate artifact from a separate bundler pass; loading
	// it is the only way to know the "require" condition points at something that
	// actually evaluates.
	await Bun.write(
		join(consumer, "smoke.cjs"),
		`const specifiers = ${JSON.stringify(specifiers)};
const failures = [];
for (const s of specifiers) {
	try {
		const m = require(s);
		if (Object.keys(m).length === 0) failures.push(s + ": required but exports nothing");
	} catch (err) {
		failures.push(s + ": " + err.message);
	}
}
for (const f of failures) console.log("FAIL " + f);
console.log("checked " + specifiers.length + " subpaths via require() on node " + process.version);
process.exit(failures.length > 0 ? 1 : 0);
`,
	);
	const smokeCjs = run(["node", "smoke.cjs"], consumer);
	for (const line of smokeCjs.stdout.split("\n")) {
		if (line.startsWith("FAIL ")) errors.push(`node runtime (cjs): ${line.slice(5)}`);
	}
	if (!smokeCjs.ok && !smokeCjs.stdout.includes("FAIL ")) {
		errors.push(`node runtime (cjs): smoke test exited ${smokeCjs.stdout}${smokeCjs.stderr}`.trim());
	}

	// ── No build-machine paths in the artifact ───────────────────────────────
	// The CJS pass has to be told how to express `import.meta.url`; get it wrong
	// and the bundler bakes in the absolute path of whoever ran the build, which
	// both leaks that path and makes optional-dependency resolution start from a
	// directory the consumer does not have.
	const installed = join(consumer, "node_modules", pkg.name);
	for (const file of new Bun.Glob("**/*.{js,cjs,d.ts,d.cts}").scanSync({ cwd: installed })) {
		const text = await Bun.file(join(installed, file)).text();
		if (text.includes(root)) {
			errors.push(`build path leaked into ${file} (contains ${root})`);
		}
	}

	// ── Types: resolve by package name, without Bun/Node ambient types ───────
	// `verify:exports` type-checks the emitted d.ts by relative path; this checks
	// the "exports" map itself resolves under node16, which is what a consumer's
	// `import "reflectdb/server"` actually goes through.
	const typeEntry = specifiers
		.map((s, i) => `import type * as m${i} from "${s}";\nexport type M${i} = typeof m${i};`)
		.join("\n");
	await Bun.write(join(consumer, "index.ts"), typeEntry);
	// Same imports from a .cts file: under node16 that resolves the "require"
	// condition instead of "import", so it checks the .d.cts declarations — a
	// separate set of files the ESM entry never touches.
	await Bun.write(join(consumer, "index.cts"), typeEntry);
	await Bun.write(
		join(consumer, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				module: "node16",
				moduleResolution: "node16",
				target: "es2022",
				strict: true,
				jsx: "react-jsx",
				noEmit: true,
				skipLibCheck: false,
				types: [],
			},
			include: ["index.ts", "index.cts"],
		}),
	);
	// The repo's own tsc, so the consumer install stays small; module resolution
	// is driven by the consumer's tsconfig and node_modules, not by where the
	// compiler binary lives.
	// `-p tsconfig.json` relative to cwd, not an absolute path: tsc reports
	// diagnostics relative to the project it was handed, and an absolute one makes
	// it print the entry file as a long `../../..` walk (worse on macOS, where the
	// temp dir resolves through /private). Relative keeps it a bare `index.ts(…)`,
	// which is what the filter below has to recognise.
	const tsc = run([resolve(root, "node_modules/.bin/tsc"), "-p", "tsconfig.json"], consumer);
	// drizzle-orm's own declarations emit unrelated diagnostics under `types: []`;
	// only our package and the consumer's entry file are in scope here.
	for (const line of tsc.stdout.split("\n")) {
		if (!line.includes("error TS")) continue;
		if (
			line.startsWith("index.ts(") ||
			line.startsWith("index.cts(") ||
			line.includes(`node_modules/${pkg.name}/`) ||
			line.includes(`node_modules\\${pkg.name}\\`)
		) {
			errors.push(`node types: ${line.trim()}`);
		}
	}
	// tsc exits non-zero on the third-party noise we deliberately filter out, so a
	// bad exit code alone means nothing. What must not happen is tsc failing
	// without emitting diagnostics at all — a missing compiler or an unreadable
	// tsconfig would otherwise read as "types are fine".
	if (!tsc.ok && !tsc.stdout.includes("error TS")) {
		errors.push(`node types: tsc failed without diagnostics\n${tsc.stdout}${tsc.stderr}`.trim());
	}
} finally {
	rmSync(workdir, { recursive: true, force: true });
}

if (errors.length > 0) {
	console.error(`✗ ${errors.length} Node consumer problem(s):`);
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log(
	`✓ ${specifiers.length} subpaths install, import, require, and type-check (both conditions) from the packed tarball on Node`,
);
