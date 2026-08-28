/**
 * In-memory `ObjectDriver` with fault injection.
 *
 * This driver exists for one reason above all: **CAS races do not reproduce
 * naturally**. Two writers colliding on `_lease`, a zombie writer whose manifest
 * CAS loses by 412, a store that goes slow mid-flush — none of that shows up by
 * running the suite harder. It has to be injected, deterministically, at a
 * chosen call. `faults.before` is that lever, and `stats` is how a test asserts
 * the cost side of the design ("an idle room issues zero PUTs", "a batch is one
 * PUT, not one per op").
 *
 * Semantics match `docs/object-storage.md` exactly, so the same conformance
 * suite runs against this, the filesystem driver, and a real S3 bucket.
 *
 * No `node:` import here or anywhere in this directory — `bunup` builds `src/`
 * with `target: "browser"` and hoists any Node builtin into a chunk every entry
 * point side-effect-imports. See `src/server/node-require.ts`.
 */

import {
	type ObjectDriver,
	type ObjectListEntry,
	type ObjectPutOptions,
	type ObjectRecord,
	PreconditionFailedError,
} from "../types.ts";

/** The operations the fault hook can intercept. One hook call per driver call. */
export type MemoryDriverOp = "get" | "put" | "list" | "delete";

export interface MemoryDriverFaultContext {
	op: MemoryDriverOp;
	/**
	 * The key the call names. For `list` this is the prefix; for `delete`, which
	 * is a single request against the store (S3 `DeleteObjects`), it is every key
	 * joined with `","` — a fault there aborts the whole batch, as a real 500
	 * would.
	 */
	key: string;
	/**
	 * 1-based ordinal across *all* operations on this driver, so a test can pin a
	 * fault to a point in a sequence ("the 4th thing this room does"). For "the
	 * 2nd put" specifically, read `stats.put` inside the hook: counters are
	 * incremented before the hook runs, so during the 2nd put `stats.put === 2`.
	 */
	call: number;
}

/**
 * What to inject. `undefined` (or no hook) means "proceed normally".
 *
 * When both fields are given the delay happens *first*, then the throw — that is
 * the shape of a real store failure worth testing, a request that hangs and then
 * fails, rather than one that fails instantly.
 */
export type MemoryDriverFault =
	| { throw: Error }
	| { delayMs: number }
	| { throw: Error; delayMs: number };

export interface MemoryDriverOptions {
	/**
	 * Reported as `caps.casWildcard`. Configurable so the MinIO path — a store
	 * that supports `If-Match` but rejects `If-None-Match: *` — is testable
	 * without a MinIO. Defaults to `true`.
	 */
	casWildcard?: boolean;
	faults?: {
		/**
		 * Called before each operation. Return a fault to inject it, or
		 * `undefined` / nothing to let the operation proceed.
		 */
		before?(ctx: MemoryDriverFaultContext): MemoryDriverFault | void;
	};
}

/** Test affordances layered on top of the driver contract. */
export interface MemoryDriverHandle {
	/**
	 * Call counts per operation, for asserting the *cost* of a design decision
	 * rather than its behavior. Counts attempts: a call a fault aborted is still
	 * a call the room decided to make, which is the thing under test.
	 */
	stats: { get: number; put: number; list: number; delete: number };
	/**
	 * Snapshot of the whole store, keys in ascending order, bodies copied. For
	 * asserting what actually landed without going through `list` + `get` (which
	 * would itself move `stats` and fire fault hooks).
	 */
	dump(): Map<string, Uint8Array>;
}

/** Byte-wise ascending, not `localeCompare`. See `sortKeys` below. */
function compareKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMemoryDriver(
	options: MemoryDriverOptions = {},
): ObjectDriver & MemoryDriverHandle {
	const casWildcard = options.casWildcard ?? true;
	const store = new Map<string, { body: Uint8Array; etag: string }>();

	// Etags are opaque to every caller — only equality matters — so a counter is
	// enough, and unlike a content hash it changes even when a write stores the
	// same bytes twice. That makes a lost-update test ("writer B overwrote with
	// identical content, does A's If-Match still fail?") expressible here.
	// Quoted because real S3 etags are quoted, and a driver that dropped the
	// quotes would let a caller accidentally depend on the unquoted form.
	let etagCounter = 0;
	let calls = 0;

	const stats = { get: 0, put: 0, list: 0, delete: 0 };

	/**
	 * Runs the fault hook for one operation and applies whatever it returns.
	 * Every public method awaits this before touching `store`, so an injected
	 * throw leaves state exactly as it was — the same guarantee a network failure
	 * before the request lands gives you.
	 */
	async function enter(op: MemoryDriverOp, key: string): Promise<void> {
		calls += 1;
		stats[op] += 1;
		const fault = options.faults?.before?.({ op, key, call: calls });
		if (!fault) return;
		if ("delayMs" in fault && fault.delayMs > 0) await delay(fault.delayMs);
		if ("throw" in fault) throw fault.throw;
	}

	return {
		caps: { casWildcard },

		stats,

		dump(): Map<string, Uint8Array> {
			const out = new Map<string, Uint8Array>();
			const sorted = [...store].sort((a, b) => compareKeys(a[0], b[0]));
			for (const [key, record] of sorted) out.set(key, new Uint8Array(record.body));
			return out;
		},

		async get(key: string): Promise<ObjectRecord | null> {
			await enter("get", key);
			const record = store.get(key);
			if (!record) return null;
			// Copy out: a caller that decodes into place, or reuses the buffer as
			// scratch, must not be able to corrupt the stored object. A real store
			// hands back fresh bytes every GET and callers rely on that.
			return { body: new Uint8Array(record.body), etag: record.etag };
		},

		async put(key: string, body: Uint8Array, opts?: ObjectPutOptions): Promise<string> {
			await enter("put", key);

			const wantsIfMatch = opts?.ifMatch !== undefined;
			const wantsIfNoneMatch = opts?.ifNoneMatch !== undefined;

			// Not a `PreconditionFailedError`: S3 rejects this combination outright,
			// and a caller sending both has a bug in its CAS logic rather than a
			// lost race. Surfacing it as 412 would send that caller into a re-read
			// and retry loop that can never succeed.
			if (wantsIfMatch && wantsIfNoneMatch) {
				throw new Error(
					`put("${key}") passed both ifMatch and ifNoneMatch. A conditional write is either create-if-absent or overwrite-if-unchanged, never both.`,
				);
			}

			if (wantsIfNoneMatch) {
				// Checked before the existence test on purpose: on a non-wildcard
				// store the operation is unsupported no matter what is in the bucket,
				// and the caller needs the same answer either way.
				//
				// Plain `Error`, emphatically not `PreconditionFailedError`: a 412
				// means "someone else created it first, re-read and decide", which a
				// writer-election loop handles by backing off. "This store cannot do
				// create-if-absent at all" is unrecoverable and needs `init()` at
				// deploy time. Making them the same error class would turn a
				// misconfiguration into an infinite, silent election retry.
				if (!casWildcard) {
					throw new Error(
						`put("${key}") used ifNoneMatch: "*", but this driver reports caps.casWildcard === false. Stores without wildcard CAS (MinIO) need a one-time init() that seeds _lease and _manifest unconditionally; every later write is a plain ifMatch.`,
					);
				}
				if (store.has(key)) {
					throw new PreconditionFailedError(
						key,
						`Conditional write failed for "${key}": ifNoneMatch: "*" but the key already exists`,
					);
				}
			}

			if (wantsIfMatch) {
				const current = store.get(key);
				// Absent counts as a mismatch, matching S3: `If-Match` against a
				// deleted key is 412, never a create.
				if (!current || current.etag !== opts?.ifMatch) {
					throw new PreconditionFailedError(
						key,
						`Conditional write failed for "${key}": ifMatch ${opts?.ifMatch} but stored etag is ${current ? current.etag : "(absent)"}`,
					);
				}
			}

			etagCounter += 1;
			const etag = `"${etagCounter}"`;
			// Copy in, for the mirror of the reason `get` copies out: the caller
			// owns `body` and may reuse it for the next batch.
			store.set(key, { body: new Uint8Array(body), etag });
			return etag;
		},

		async list(prefix: string): Promise<ObjectListEntry[]> {
			await enter("list", prefix);
			const entries: ObjectListEntry[] = [];
			for (const [key, record] of store) {
				if (key.startsWith(prefix)) entries.push({ key, size: record.body.byteLength });
			}
			// Sorted ascending, and by code unit rather than locale: WAL replay
			// applies segments in listing order, so ordering is correctness, not
			// tidiness. `localeCompare` would order `wal/10-1` against `wal/9-1`
			// differently under an ICU-aware runtime than under a minimal one, which
			// is exactly the kind of bug that only appears in production. S3's
			// ListObjectsV2 sorts by UTF-8 byte order; this matches it for the ASCII
			// keys the layout uses.
			entries.sort((a, b) => compareKeys(a.key, b.key));
			return entries;
		},

		async delete(keys: string[]): Promise<void> {
			await enter("delete", keys.join(","));
			for (const key of keys) store.delete(key);
		},
	};
}
