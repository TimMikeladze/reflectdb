/**
 * Fail the build if any artifact carries React's development JSX runtime.
 *
 * Bun chooses the runtime from NODE_ENV while transpiling. A dev-mode build
 * imports `jsxDEV` from `react/jsx-dev-runtime`, which React's production build
 * does not export — so `<SyncProvider>` throws
 * `TypeError: (0, x.jsxDEV) is not a function` in any consumer that bundles for
 * production. Nothing about the build fails on its own, and the ESM and CJS
 * artifacts look correct, so this check is the only thing standing between that
 * mistake and a published release.
 *
 * Run by `bun run build`; see the NODE_ENV note in bunup.config.ts.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
const FORBIDDEN = ["react/jsx-dev-runtime", "jsxDEV"];

const walk = async (dir: string): Promise<string[]> => {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return walk(path);
			return /\.(js|cjs|mjs)$/.test(entry.name) ? [path] : [];
		}),
	);
	return files.flat();
};

const offenders: string[] = [];
for (const file of await walk(DIST)) {
	const source = await Bun.file(file).text();
	const hit = FORBIDDEN.find((needle) => source.includes(needle));
	if (hit) offenders.push(`${file.replace(DIST, "dist/")} → ${hit}`);
}

if (offenders.length > 0) {
	console.error("Development JSX runtime found in published output:\n");
	for (const line of offenders) console.error(`  ${line}`);
	console.error(
		"\nReact's production build does not export `jsxDEV`, so this would throw" +
			"\n`TypeError: (0, x.jsxDEV) is not a function` in every consumer that" +
			"\nbundles for production. Build with NODE_ENV=production (bunup.config.ts" +
			"\npins it) and re-run.",
	);
	process.exit(1);
}

console.log("verify:jsx — production JSX runtime in all artifacts");
