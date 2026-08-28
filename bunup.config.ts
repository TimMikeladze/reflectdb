import { defineConfig } from "bunup";

// Bun's transpiler picks the JSX runtime from NODE_ENV at build time: anything
// other than "production" emits `jsxDEV` from `react/jsx-dev-runtime`. React's
// production build does not export `jsxDEV`, so a dev-mode artifact makes
// `<SyncProvider>` die with `TypeError: (0, x.jsxDEV) is not a function` in
// every consumer that bundles for production — Next, Vite, anything. The build
// still succeeds, which is what makes it easy to ship.
//
// The npm `build` script sets NODE_ENV=production because Bun reads it before
// this config is evaluated — assigning `process.env.NODE_ENV` here is too late
// to change the transpiler's choice. This assignment is a floor for anyone who
// runs `bunup` directly with NODE_ENV unset, not a substitute for the script.
// `scripts/verify-jsx.ts` is what actually guarantees it: the build fails if a
// dev-runtime reference survives into dist/.
process.env.NODE_ENV ??= "production";

const entry = [
	"src/core/index.ts",
	"src/client/index.ts",
	"src/server/index.ts",
	"src/server/drizzle.ts",
	"src/transport/ws.ts",
	"src/transport/bun-ws.ts",
	"src/transport/sse.ts",
	"src/transport/polling.ts",
	"src/react/index.ts",
	"src/svelte/index.ts",
	"src/vanilla/index.ts",
	"src/client/storage/indexeddb.ts",
	"src/server/ephemeral/index.ts",
	"src/server/ephemeral/redis.ts",
	"src/server/storage/object/index.ts",
];

// Pin the base directory so output lands at dist/<subpath>/index.js rather
// than dist/src/<subpath>/index.js. The "exports" map in package.json is
// written against the former; `bun run verify:exports` enforces the match.
const shared = {
	entry,
	sourceBase: "./src",
	dts: true,
	external: ["drizzle-orm", "react"],
};

// Two configs rather than one with `format: ["esm", "cjs"]`, because only the
// CJS output may carry the `define` below. They get SEPARATE output directories:
// pointed at one, the second pass rewrites the shared chunks the first emitted
// and leaves the ESM entry points re-exporting names that no longer exist —
// which every entry still "builds" cleanly through, failing only on import.
// NOTE: do not add `sideEffects` to package.json. Bun's bundler reads that field
// while building this package itself and tree-shakes our own modules away — the
// build still reports success, but every entry point is left re-exporting names
// that no longer exist and fails at import. Both `false` and `[]` do it.
// Consumers still tree-shake fine: no entry point runs code at import time, and
// the per-feature subpaths keep `reflectdb/core` from pulling in `reflectdb/server`.
export default defineConfig([
	{
		name: "esm",
		...shared,
		format: ["esm"],
		clean: true,
		// NOT bunup's default `target: "node"`. Under that target Bun's bundler
		// emits its `__require` interop shim as `import { createRequire } from
		// "node:module"`, puts it in a shared chunk, and side-effect-imports that
		// chunk from EVERY entry — `reflectdb/core`, `reflectdb/client` and
		// `reflectdb/react` included. Nothing in this package ever calls the shim,
		// but the import is static, so a browser bundler sees a client chunk
		// reaching for a Node builtin. Turbopack refuses it outright:
		//
		//   the chunking context (unknown) does not support external modules
		//   (request: node:module)
		//
		// and every consumer needs an alias to a hand-written stub to build at all.
		// The browser target emits the same shim as a portable `require`-sniffing
		// closure with no import, which the server entries never reach either.
		//
		// Safe because no module under src/ imports a `node:` builtin — the one
		// place that needs CommonJS resolution goes through
		// `src/server/node-require.ts`, which reads `process.getBuiltinModule` at
		// call time. Keep it that way: a `node:` import anywhere in src/ would be
		// bundled as a bare external here and fail on Node instead of being
		// hoisted. `bun run verify:node` is what catches it.
		target: "browser",
	},
	{
		name: "cjs",
		...shared,
		format: ["cjs"],
		outDir: "dist/cjs",
		// CJS has no `import.meta`. Left alone the bundler emits it verbatim — a
		// hard SyntaxError on require — and `shims: true` "fixes" that by baking
		// the absolute build-machine path into the artifact, which both leaks that
		// path and makes optional-dependency resolution (drizzle-orm) run from a
		// directory that does not exist on the consumer's machine.
		// `module.filename` is the emitted file's own path, so resolution starts
		// where the package actually lives. NOT `__filename`: Bun rewrites that to
		// the *source* path in bundled CJS, reintroducing both problems.
		// `bun run verify:node` fails if a build path reaches dist/ again.
		define: {
			"import.meta.url": "module.filename",
			"import.meta": "{}",
		},
		// Same reason as the esm pass: the node target opens every CJS entry with
		// `require("node:module")` for a shim nothing calls, which a bundler
		// resolving the "require" condition for the browser then has to polyfill
		// or fail on.
		target: "browser",
	},
]);
