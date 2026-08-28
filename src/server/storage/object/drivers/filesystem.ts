/**
 * Filesystem `ObjectDriver` — the whole object-storage suite, runnable with no
 * network and no credentials. Same observable semantics as the memory driver,
 * so one conformance suite covers both and a real bucket.
 *
 * **For tests and single-process development only.** A filesystem has no
 * conditional write, so CAS here is read-etag, compare, rename — three syscalls
 * with no atomicity between them. Two processes sharing a `rootDir` can both
 * read the same etag, both find it matching, and both rename: the second write
 * silently wins and the first is lost, with neither caller seeing a 412. That is
 * precisely the failure the manifest CAS exists to prevent, so do not point two
 * servers at one directory. Use the S3 driver, where the compare happens inside
 * the store, for anything with more than one writer process.
 *
 * Within a single process the driver is still useful and honest: every method is
 * synchronous under an async signature, so nothing interleaves between the
 * compare and the rename, and the CAS behaves exactly like a real one.
 *
 * Two keyspace limits follow from being a filesystem rather than a flat store,
 * and both are refused loudly rather than approximated:
 *
 *  - A key that is also a prefix of another (`a` alongside `a/b`) is legal in S3
 *    and impossible here, since `a` is either a file or a directory.
 *  - A `..` segment is a literal part of an S3 key — `a/b/../c` and `a/c` are
 *    different objects — and cannot be represented as a path.
 *
 * reflectdb's own layout (`_manifest`, `_lease`, `wal/…`, `snap/…`) hits
 * neither, so this only constrains callers inventing their own keys.
 *
 * `node:fs` is reached through `nodeRequire` and resolved lazily inside the
 * factory. A static `import ... from "node:fs"` would be hoisted by `bunup`
 * (which builds `src/` with `target: "browser"`) into a shared chunk that every
 * entry point — `reflectdb/core` and `reflectdb/react` included — side-effect
 * imports, breaking consumer bundles outright. See `src/server/node-require.ts`.
 */

import { nodeRequire } from "../../../node-require.ts";
import {
	type ObjectDriver,
	type ObjectListEntry,
	type ObjectPutOptions,
	type ObjectRecord,
	PreconditionFailedError,
} from "../types.ts";

/**
 * Structural stand-in for the slice of `node:fs` this driver uses, in the spirit
 * of `BunDatabase` in `storage/sqlite.ts`: a real `node:fs` satisfies it, and no
 * `@types/node` reference survives into the emitted declarations for consumers
 * who type-check without them. It also serves as the exhaustive list of what
 * this driver actually needs from the runtime.
 *
 * Sync APIs throughout. The driver interface is already async, so the wrapper is
 * a formality — and the compare-then-rename sequence below stays free of an
 * await point, which is what keeps single-process CAS honest.
 */
interface NodeDirent {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

interface NodeFs {
	existsSync(path: string): boolean;
	mkdirSync(path: string, options: { recursive: boolean }): void;
	readFileSync(path: string): Uint8Array;
	writeFileSync(path: string, data: Uint8Array): void;
	renameSync(from: string, to: string): void;
	unlinkSync(path: string): void;
	readdirSync(path: string, options: { withFileTypes: true }): NodeDirent[];
	statSync(path: string): { size: number };
}

// `node:fs` exists only on a server runtime, and this module is reachable from
// `reflectdb/server`. Resolve it on the filesystem path alone so importing the
// server entry point in a worker or an edge runtime stays possible.
function loadFs(): NodeFs {
	try {
		return nodeRequire("node:fs") as NodeFs;
	} catch {
		throw new Error(
			"createFilesystemDriver requires a Node-compatible runtime (node:fs is unavailable). Use createMemoryDriver where there is no filesystem.",
		);
	}
}

/**
 * Prefix for in-flight temp files. They live in the target's own directory (a
 * rename is only atomic within one filesystem, and a sibling is the only
 * placement that guarantees that), which means `list` would otherwise report
 * them as objects — half-written ones at that. The walk skips this prefix, and
 * the leading dot keeps them out of casual `ls` output too.
 */
const TEMP_PREFIX = ".reflectdb-tmp-";

/** `ENOENT` / `ENOTDIR` — the key, or a directory on the way to it, is absent. */
function isNotFound(error: unknown): boolean {
	const code = (error as { code?: string } | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * FNV-1a 64-bit over the bytes, hex, quoted like a real S3 etag.
 *
 * Content-derived, deliberately **not** mtime-derived: mtime has one-second
 * granularity on some filesystems (and coarse-but-nonzero granularity on most),
 * so two writes inside the same tick would produce the same etag and a CAS that
 * should have failed would quietly succeed. A silently broken linearization
 * point is the worst possible bug in this design, so the etag is a function of
 * the bytes and nothing else. This also mirrors S3, whose etag is a content hash
 * as well: rewriting identical bytes leaves the etag unchanged in both.
 *
 * `node:crypto` is unavailable to this directory (browser build target) and
 * WebCrypto's digest is async and vastly overkill — an etag needs collision
 * *resistance under accident*, not under attack. FNV-1a is a few lines and runs
 * at memory speed.
 *
 * Carried as four 16-bit limbs rather than a `BigInt`: hashing a 4 MiB WAL batch
 * would allocate a BigInt per byte, which turns a microsecond into a hundred
 * milliseconds on every flush. Each intermediate below stays under 2^31, so the
 * `>>>` and `&` coercions are exact.
 */
function contentEtag(bytes: Uint8Array): string {
	// Offset basis 0xcbf29ce484222325, low limb first.
	let h0 = 0x2325;
	let h1 = 0x8422;
	let h2 = 0x9ce4;
	let h3 = 0xcbf2;
	for (const byte of bytes) {
		h0 ^= byte;
		// Multiply by the FNV prime 0x100000001b3, whose only non-zero limbs are
		// 0x01b3 (limb 0) and 0x0100 (limb 2), then carry upward and drop the
		// overflow past 64 bits.
		const t0 = h0 * 0x1b3;
		const t1 = h1 * 0x1b3 + (t0 >>> 16);
		const t2 = h2 * 0x1b3 + h0 * 0x100 + (t1 >>> 16);
		const t3 = h3 * 0x1b3 + h1 * 0x100 + (t2 >>> 16);
		h0 = t0 & 0xffff;
		h1 = t1 & 0xffff;
		h2 = t2 & 0xffff;
		h3 = t3 & 0xffff;
	}
	const limb = (value: number) => value.toString(16).padStart(4, "0");
	return `"${limb(h3)}${limb(h2)}${limb(h1)}${limb(h0)}"`;
}

/** Byte-wise ascending. See the ordering comment on `list`. */
function compareKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function rejectKey(key: string, reason: string): never {
	throw new Error(
		`Invalid object key ${JSON.stringify(key)}: ${reason}. Keys are store-relative paths; the filesystem driver maps them under its root and refuses anything that could escape it.`,
	);
}

/**
 * Validates one `/`-separated path fragment.
 *
 * This is a path-traversal guard, not input tidying. Object keys reach this
 * driver from room ids and, further out, from user-controlled identifiers; a key
 * of `../../../../etc/passwd` would otherwise resolve to a real path and let a
 * caller read or overwrite arbitrary files as whatever user the server runs as.
 * Rejecting the components outright is checkable by eye, unlike a resolve-then-
 * compare against the root, which has to get symlinks and case-insensitive
 * filesystems right to be sound.
 *
 * Backslashes are rejected wholesale because Windows treats them as separators,
 * so `..\\..\\etc` is a traversal there while looking like one harmless segment
 * to a `/`-only check.
 */
function checkSegments(key: string, segments: string[], allowEmpty: boolean): void {
	for (const segment of segments) {
		if (segment === "" && !allowEmpty) rejectKey(key, "it contains an empty path segment");
		if (segment === "." || segment === "..") {
			rejectKey(key, `it contains a "${segment}" segment, which escapes or re-roots the path`);
		}
		if (segment.includes("\\")) rejectKey(key, "it contains a backslash");
	}
}

/** Maps an object key to an absolute path under `root`, or throws. */
function resolveKeyPath(root: string, key: string): string {
	if (key === "") rejectKey(key, "it is empty");
	if (key.startsWith("/")) rejectKey(key, "it is an absolute path");
	if (/^[a-zA-Z]:/.test(key)) rejectKey(key, "it starts with a drive letter");
	checkSegments(key, key.split("/"), false);
	return `${root}/${key}`;
}

/** The directory portion of a path built by `resolveKeyPath` (never empty). */
function dirnameOf(path: string): string {
	return path.slice(0, path.lastIndexOf("/"));
}

function walk(fs: NodeFs, dir: string, base: string, out: ObjectListEntry[]): void {
	let entries: NodeDirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		// A prefix naming a directory that was never created is an empty listing,
		// not an error — the same answer S3 gives for a prefix with no objects.
		if (isNotFound(error)) return;
		throw error;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(TEMP_PREFIX)) continue;
		const path = `${dir}/${entry.name}`;
		// Keys are joined with "/" no matter the platform: they are store keys,
		// not paths, and a caller comparing them against `wal/${epoch}-${seq}`
		// must get the same answer on Windows as on Linux. Nothing here ever
		// introduces a backslash, so the invariant holds by construction.
		const key = base === "" ? entry.name : `${base}/${entry.name}`;
		if (entry.isDirectory()) {
			walk(fs, path, key, out);
		} else if (entry.isFile()) {
			out.push({ key, size: fs.statSync(path).size });
		}
	}
}

export function createFilesystemDriver(rootDir: string): ObjectDriver & { close?(): void } {
	const fs = loadFs();

	// Trailing slashes would double up in every join and turn `dirnameOf` into a
	// no-op for top-level keys.
	const root = rootDir.replace(/[/\\]+$/, "");
	if (root === "") {
		throw new Error(
			"createFilesystemDriver requires a non-empty rootDir. Refusing to treat the filesystem root as an object store.",
		);
	}
	// Created eagerly so a driver pointed at a fresh temp directory works without
	// the caller having to prepare it; `put` creates the deeper levels lazily.
	fs.mkdirSync(root, { recursive: true });

	let tempCounter = 0;

	/** Current etag of `path`, or `null` when there is no object there. */
	function readEtag(path: string): string | null {
		try {
			return contentEtag(fs.readFileSync(path));
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	return {
		// Nothing prevents create-if-absent on a filesystem, so the wildcard path
		// (rather than the MinIO `init()` path) is what this driver exercises.
		caps: { casWildcard: true },

		async get(key: string): Promise<ObjectRecord | null> {
			const path = resolveKeyPath(root, key);
			let body: Uint8Array;
			try {
				body = fs.readFileSync(path);
			} catch (error) {
				// EISDIR: the key names a directory that only exists because deeper
				// keys live under it. There is no object at that key, which is
				// absence, not a failure.
				if (isNotFound(error) || (error as { code?: string })?.code === "EISDIR") return null;
				throw error;
			}
			// A Buffer is already a Uint8Array; re-viewing it hands back the plain
			// type the contract promises without copying the bytes again.
			return {
				body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
				etag: contentEtag(body),
			};
		},

		async put(key: string, body: Uint8Array, opts?: ObjectPutOptions): Promise<string> {
			const path = resolveKeyPath(root, key);

			const wantsIfMatch = opts?.ifMatch !== undefined;
			const wantsIfNoneMatch = opts?.ifNoneMatch !== undefined;

			// Caller bug, not a lost race: S3 rejects the combination outright, and
			// surfacing it as a 412 would send the caller into a re-read-and-retry
			// loop that can never succeed.
			if (wantsIfMatch && wantsIfNoneMatch) {
				throw new Error(
					`put("${key}") passed both ifMatch and ifNoneMatch. A conditional write is either create-if-absent or overwrite-if-unchanged, never both.`,
				);
			}

			// The compare and the rename below are separate syscalls, so this CAS is
			// only sound within one process. See the file header: a second process
			// sharing this root can pass the same compare and clobber the winner.
			if (wantsIfNoneMatch && fs.existsSync(path)) {
				throw new PreconditionFailedError(
					key,
					`Conditional write failed for "${key}": ifNoneMatch: "*" but the key already exists`,
				);
			}
			if (wantsIfMatch) {
				const current = readEtag(path);
				// Absent counts as a mismatch, matching S3: `If-Match` against a
				// deleted key is a 412, never a create.
				if (current === null || current !== opts?.ifMatch) {
					throw new PreconditionFailedError(
						key,
						`Conditional write failed for "${key}": ifMatch ${opts?.ifMatch} but stored etag is ${current ?? "(absent)"}`,
					);
				}
			}

			const dir = dirnameOf(path);
			// An object store's keyspace is flat: `a` and `a/b` are two unrelated
			// objects and both may exist. A filesystem cannot represent that — `a`
			// is either a file or a directory — so this is the one place where the
			// driver genuinely cannot match S3.
			//
			// Raised as a named error rather than letting `mkdirSync` surface a bare
			// `EEXIST`, which points at a temp path and says nothing about keys.
			// reflectdb's own layout never collides (`_manifest`, `_lease`, `wal/…`,
			// `snap/…` — no key is also a directory prefix), so this only fires for
			// a caller inventing its own keys.
			try {
				fs.mkdirSync(dir, { recursive: true });
			} catch (error) {
				if ((error as { code?: string } | null)?.code === "EEXIST") {
					throw new Error(
						`Cannot write object "${key}": a prefix of that key already exists as an object. Object stores allow "a" and "a/b" to coexist; a filesystem cannot, so the filesystem driver rejects the collision instead of losing one of them. Use createMemoryDriver or a real bucket if you need a key that is also a prefix.`,
						{ cause: error },
					);
				}
				throw error;
			}

			// Write elsewhere, then rename over the target. `writeFileSync` straight
			// to the target would truncate first and fill afterwards, so a concurrent
			// `get` — WAL replay racing a flush, say — could read a zero-length or
			// half-written object and fail to parse it as JSON. `rename` within one
			// directory is atomic on every filesystem this runs on: a reader sees the
			// old object or the new one, never a partial.
			tempCounter += 1;
			const temp = `${dir}/${TEMP_PREFIX}${tempCounter}-${Math.random().toString(36).slice(2)}`;
			try {
				fs.writeFileSync(temp, body);
				fs.renameSync(temp, path);
			} catch (error) {
				// Best effort: leaving the temp behind would leak a file per failed
				// write, and `list` hides it, so nothing would ever clean it up.
				try {
					fs.unlinkSync(temp);
				} catch {
					// Already gone, or unlinkable for the same reason the write failed.
				}
				throw error;
			}
			// Hashed from the bytes we were handed rather than re-read from disk:
			// identical result, one fewer syscall on the hot flush path.
			return contentEtag(body);
		},

		async list(prefix: string): Promise<ObjectListEntry[]> {
			// Prefixes legitimately end in "/" and may be empty (list everything), so
			// empty segments are allowed here — but traversal is not.
			if (prefix.startsWith("/")) rejectKey(prefix, "it is an absolute path");
			if (/^[a-zA-Z]:/.test(prefix)) rejectKey(prefix, "it starts with a drive letter");
			checkSegments(prefix, prefix.split("/"), true);

			// Any key starting with `prefix` lives under the directory named by the
			// part of the prefix up to its last "/", so the walk starts there instead
			// of at the root. Without this, listing one room's WAL scans every room
			// in the store.
			const cut = prefix.lastIndexOf("/");
			const base = cut === -1 ? "" : prefix.slice(0, cut);
			const entries: ObjectListEntry[] = [];
			walk(fs, base === "" ? root : `${root}/${base}`, base, entries);

			// The fragment after the last "/" still has to be matched — the walk only
			// narrowed the directory it started from.
			const matched = entries.filter((entry) => entry.key.startsWith(prefix));

			// Ascending, and by code unit rather than locale. WAL replay applies
			// segments in listing order, so ordering is correctness rather than
			// tidiness: `readdirSync` returns whatever order the filesystem feels
			// like, and `localeCompare` would sort `wal/10-1` against `wal/9-1`
			// differently on an ICU-aware runtime than on a minimal one — a bug that
			// only shows up in production. S3's ListObjectsV2 orders by UTF-8 bytes;
			// this matches it for the ASCII keys the layout uses.
			matched.sort((a, b) => compareKeys(a.key, b.key));
			return matched;
		},

		async delete(keys: string[]): Promise<void> {
			for (const key of keys) {
				const path = resolveKeyPath(root, key);
				try {
					fs.unlinkSync(path);
				} catch (error) {
					// Absent keys are not an error, per the driver contract — GC deleting
					// a segment twice must be a no-op the second time.
					if (isNotFound(error)) continue;
					throw error;
				}
			}
			// Emptied directories are left in place. Pruning them would race a
			// concurrent `put` creating a sibling under the same parent, and `list`
			// reports files only, so an empty directory is invisible anyway.
		},
	};
}
