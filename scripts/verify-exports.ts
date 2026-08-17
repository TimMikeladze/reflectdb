/**
 * Verifies the "exports" map in package.json against the actual build output.
 *
 * The build writes to dist/ via bunup's `sourceBase`, and the exports map is
 * maintained by hand — nothing else in CI reads both. When they drift, every
 * subpath import fails for consumers while type-check, lint, and tests all
 * still pass, so the breakage only surfaces after publish.
 *
 * Run against a fresh `bun run build`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");
const errors: string[] = [];

type Condition = { types?: string; default?: string };
type ExportEntry = {
	import?: Condition;
	require?: Condition;
};

/** Both conditions are mandatory: the package ships a dual ESM + CJS build. */
const CONDITIONS = ["import", "require"] as const;

const exportsMap = pkg.exports as Record<string, ExportEntry | string>;

/** Subpaths that ship a file directly rather than a built entry point. */
const PASSTHROUGH = new Set(["./package.json"]);

const subpaths: string[] = [];

for (const [subpath, entry] of Object.entries(exportsMap)) {
	if (PASSTHROUGH.has(subpath)) {
		if (typeof entry === "string" && !existsSync(resolve(root, entry))) {
			errors.push(`${subpath}: missing ${entry}`);
		}
		continue;
	}

	if (typeof entry === "string") {
		errors.push(`${subpath}: expected a conditional object, got a string`);
		continue;
	}

	let complete = true;
	for (const name of CONDITIONS) {
		const condition = entry[name];
		if (!condition) {
			errors.push(`${subpath}: missing "${name}" condition`);
			complete = false;
			continue;
		}
		for (const field of ["types", "default"] as const) {
			const target = condition[field];
			if (!target) {
				errors.push(`${subpath}: "${name}" is missing "${field}"`);
				complete = false;
				continue;
			}
			// "types" must be declared before "default" — Node and TypeScript both
			// take the first matching key, so a "default" listed first wins and the
			// declarations are never found.
			if (Object.keys(condition)[0] !== "types") {
				errors.push(`${subpath}: "${name}" must list "types" first`);
				complete = false;
			}
			if (!existsSync(resolve(root, target))) {
				errors.push(`${subpath}: "${name}.${field}" points at ${target}, which does not exist`);
			}
		}
	}
	if (complete) subpaths.push(subpath);
}

// Every built entry point must be reachable through the exports map, otherwise
// we ship dead weight (or, worse, forget to expose a new entry point).
// dist/shared/ holds bundler-generated chunks that entry points import
// internally — they are not entry points and are never exported directly.
const declared = new Set(
	Object.values(exportsMap)
		.filter((e): e is ExportEntry => typeof e !== "string")
		.flatMap((e) => CONDITIONS.map((name) => e[name]?.default))
		.filter((p): p is string => Boolean(p)),
);
const built = new Bun.Glob("**/*.{js,cjs}").scanSync({ cwd: resolve(root, "dist") });
for (const file of built) {
	const rel = `./dist/${file.split("\\").join("/")}`;
	// shared/ holds bundler-generated chunks, under both the ESM root and the
	// CJS outDir. They are imported by entry points, never exported directly.
	if (rel.startsWith("./dist/shared/") || rel.startsWith("./dist/cjs/shared/")) continue;
	if (!declared.has(rel)) {
		errors.push(`${rel} was built but is not referenced by any export`);
	}
}

// `files` gates what npm actually uploads — an exports map pointing at dist/ is
// inert if dist/ never makes it into the tarball.
if (!(pkg.files as string[]).includes("dist")) {
	errors.push('package.json "files" must include "dist"');
}

// Resolution alone does not prove the module loads: a missing external or a
// bad top-level import fails only on import.
for (const subpath of subpaths) {
	const entry = exportsMap[subpath] as ExportEntry;
	const target = entry.import?.default;
	if (!target) continue;
	try {
		await import(resolve(root, target));
	} catch (err) {
		errors.push(`${subpath}: failed to import — ${(err as Error).message}`);
	}
}

// The emitted .d.ts files are never checked by `bun run type-check` — that
// checks src/, where Bun's ambient types and React's global UMD namespace are
// both in scope. Consumers on Node have neither, and the d.ts bundler can emit
// references that only resolve under those ambient types (a `bun:sqlite` module
// specifier, a `React.`-qualified name it renamed on import). Re-check the
// emitted declarations with `types: []`, which is what a Node consumer running
// `skipLibCheck: false` actually sees.
const checkDir = resolve(root, "node_modules/.cache/reflectdb-verify-types");
await Bun.write(
	`${checkDir}/entry.ts`,
	subpaths
		.map((subpath, i) => {
			const target = (exportsMap[subpath] as ExportEntry).import?.default;
			// `../../../` climbs out of node_modules/.cache/reflectdb-verify-types.
			return `import type * as m${i} from "../../../${target?.slice(2)}";\nexport type M${i} = typeof m${i};`;
		})
		.join("\n"),
);
await Bun.write(
	`${checkDir}/tsconfig.json`,
	JSON.stringify({
		compilerOptions: {
			module: "node16",
			moduleResolution: "node16",
			target: "es2022",
			strict: true,
			jsx: "react-jsx",
			noEmit: true,
			skipLibCheck: false,
			// Drop @types/bun and @types/node — a consumer on plain Node has
			// neither, and their absence is exactly what this check exercises.
			types: [],
		},
		include: ["entry.ts"],
	}),
);
const tsc = Bun.spawnSync(["bun", "x", "tsc", "-p", `${checkDir}/tsconfig.json`], { cwd: root });
// Third-party declarations (drizzle-orm, react) emit unrelated diagnostics under
// `types: []`; only our own emitted output is in scope here.
for (const line of new TextDecoder().decode(tsc.stdout).split("\n")) {
	if (/^dist[/\\].*error TS/.test(line)) errors.push(`emitted types: ${line.trim()}`);
}

if (errors.length > 0) {
	console.error(`✗ ${errors.length} export problem(s):`);
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log(
	`✓ ${subpaths.length} export subpaths resolve, import, and type-check without ambient Bun/React globals`,
);
