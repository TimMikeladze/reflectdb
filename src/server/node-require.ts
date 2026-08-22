/**
 * Synchronous CommonJS resolution for optional dependencies, reached without a
 * static `node:module` import.
 *
 * The obvious spelling — `import { createRequire } from "node:module"` — puts a
 * Node builtin into the module graph. Bun's bundler then hoists the resulting
 * `createRequire(import.meta.url)` into a shared chunk and side-effect-imports
 * that chunk from EVERY entry point, `reflectdb/core`, `reflectdb/client` and
 * `reflectdb/react` included, even though only the server half ever calls it.
 * Browser bundlers see a client chunk importing a Node builtin and refuse it:
 *
 *   the chunking context (unknown) does not support external modules
 *   (request: node:module)
 *
 * Turbopack fails the build outright; every consumer then needs an alias to a
 * hand-written browser stub. `process.getBuiltinModule` reaches the same
 * builtin at call time with no import statement, so nothing about Node survives
 * into the graph and the shared chunk is never emitted.
 *
 * It exists on Node >= 22.3 and Bun >= 1.1.30; `engines.node` is pinned to
 * >=22.3 for this reason alone.
 */

type RequireFn = (id: string) => unknown;

interface ModuleBuiltin {
	createRequire: (from: string | URL) => RequireFn;
}

let cached: RequireFn | undefined;

/**
 * Resolves `id` the way `require` would, relative to this module's own location
 * so resolution starts where the package actually lives.
 *
 * Throws if the runtime exposes no CommonJS resolver — callers already handle a
 * throw here as "the optional dependency is unavailable".
 */
export function nodeRequire(id: string): unknown {
	if (!cached) {
		const proc = (globalThis as { process?: { getBuiltinModule?: (name: string) => unknown } })
			.process;
		const mod = proc?.getBuiltinModule?.("node:module") as ModuleBuiltin | undefined;
		if (!mod?.createRequire) {
			throw new Error(
				`Cannot resolve "${id}": this runtime has no CommonJS resolver (process.getBuiltinModule is unavailable). reflectdb requires Node >= 22.3 or Bun >= 1.1.30 on the server.`,
			);
		}
		cached = mod.createRequire(import.meta.url);
	}
	return cached(id);
}
