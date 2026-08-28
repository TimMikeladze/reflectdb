/**
 * The S3-compatible `ObjectDriver`: raw S3 REST over global `fetch`, signed with
 * the hand-rolled SigV4 in `../sigv4.ts`.
 *
 * No AWS SDK and no `aws4fetch`. Partly because the server half of this package
 * ships zero runtime dependencies, but mostly because every off-the-shelf signer
 * imports `node:crypto`, and a `node:` import anywhere under `src/` breaks every
 * consumer's bundle — `bunup.config.ts` builds this tree with `target: "browser"`
 * and hoists the builtin into a chunk that `reflectdb/core` and `reflectdb/react`
 * both side-effect-import. `src/server/node-require.ts` has the full story.
 *
 * This is the CONTROL plane only: lease CAS, manifest CAS, WAL PUTs, GC. The
 * data plane (Parquet, phase 3) belongs to DuckDB's `httpfs`, which cannot do
 * conditional writes and therefore cannot be the CAS primitive. See
 * docs/object-storage.md, "Two clients, two roles".
 */

import { encodeUriPath, percentEncode, signRequest } from "../sigv4.ts";
import {
	type ObjectDriver,
	type ObjectDriverCapabilities,
	type ObjectListEntry,
	type ObjectPutOptions,
	type ObjectRecord,
	PreconditionFailedError,
	type StoreConfig,
	type StoreProvider,
} from "../types.ts";

const textEncoder = new TextEncoder();

/** S3's hard limit on `DeleteObjects`, and therefore our batch size. */
const MAX_KEYS_PER_DELETE = 1000;

/** Retries after the first attempt. Four attempts total, worst case. */
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;
/** Ceiling on a `Retry-After` we are willing to honour, so a hostile header cannot park a flush forever. */
const MAX_RETRY_AFTER_MS = 20_000;
/** Parallelism for the one-DELETE-per-key fallback (GCS). */
const DELETE_CONCURRENCY = 8;

// ── provider presets ──────────────────────────────────────────────────────

export interface ProviderPreset {
	/**
	 * Derives the endpoint origin when `store.endpoint` is not given. Throws for
	 * providers where no default exists (MinIO) or where a required input is
	 * missing (R2 without `accountId`).
	 */
	endpoint: (config: StoreConfig) => string;
	/** Signing region when `store.region` is not given. */
	region: string;
	urlStyle: "vhost" | "path";
	/**
	 * Whether `If-None-Match: *` (create-if-absent) works. A CAPABILITY, not a
	 * setting — see `ObjectDriverCapabilities.casWildcard`. It is fixed per
	 * provider precisely so nobody can configure a store into claiming support it
	 * does not have; the adapter's safety argument rests on this being true.
	 */
	casWildcard: boolean;
	/**
	 * Whether the store implements the `POST /?delete` multi-object API. Google's
	 * XML API does not, so the driver falls back to one DELETE per key there.
	 * Internal to the driver; `ObjectDriverCapabilities` deliberately does not
	 * model it, because callers never need to care which shape the deletes took.
	 */
	batchDelete: boolean;
}

function missingEndpoint(provider: string): never {
	throw new Error(
		`store.endpoint is required for provider "${provider}": there is no well-known endpoint to default to. Pass the URL of your ${provider} server, e.g. { provider: "${provider}", endpoint: "http://localhost:9000", bucket: "..." }.`,
	);
}

export const PROVIDER_PRESETS: Record<StoreProvider, ProviderPreset> = {
	// The regional endpoint rather than the global `s3.amazonaws.com`: the global
	// one 307-redirects to the bucket's real region, and a redirect invalidates
	// the signature (the `host` header changes), so the retried request 403s.
	aws: {
		endpoint: (config) => `https://s3.${config.region ?? "us-east-1"}.amazonaws.com`,
		region: "us-east-1",
		urlStyle: "vhost",
		casWildcard: true,
		batchDelete: true,
	},
	r2: {
		endpoint: (config) => {
			if (!config.accountId) {
				throw new Error(
					`store.accountId is required for provider "r2": the R2 endpoint is https://<accountId>.r2.cloudflarestorage.com and cannot be derived from the bucket name. Find it in the Cloudflare dashboard under R2 > Overview, or pass store.endpoint explicitly.`,
				);
			}
			return `https://${config.accountId}.r2.cloudflarestorage.com`;
		},
		// R2 is not regionalised; "auto" is what Cloudflare's own docs sign with.
		region: "auto",
		urlStyle: "vhost",
		casWildcard: true,
		batchDelete: true,
	},
	// Tigris answers on more than one hostname: `t3.storage.dev` is the one its
	// own docs use, while a bucket provisioned through `fly storage create` is
	// issued `fly.storage.tigris.dev`. Both work, but a signature covers the
	// `host` header, so pass `store.endpoint` explicitly when Fly gave you the
	// other one rather than assuming this default fits.
	tigris: {
		endpoint: () => "https://t3.storage.dev",
		region: "auto",
		urlStyle: "vhost",
		casWildcard: true,
		batchDelete: true,
	},
	// MinIO shipped conditional writes in Feb 2023 — before AWS — but never
	// accepted the `*` wildcard, only an exact etag. That single gap is why
	// `casWildcard` exists at all: on this driver the store needs a one-time
	// `init()` deploy step to seed `_lease` and `_manifest`, after which every
	// write is a plain `If-Match` that MinIO handles fine.
	// Path style because a self-hosted MinIO rarely has the wildcard DNS entry
	// and wildcard TLS certificate that vhost addressing requires.
	minio: {
		endpoint: () => missingEndpoint("minio"),
		region: "us-east-1",
		urlStyle: "path",
		casWildcard: false,
		batchDelete: true,
	},
	// GCS's S3 interoperability endpoint. Path style is the only addressing it
	// supports, and it does not implement multi-object delete.
	gcs: {
		endpoint: () => "https://storage.googleapis.com",
		region: "auto",
		urlStyle: "path",
		casWildcard: true,
		batchDelete: false,
	},
};

/**
 * Used when `store.provider` is omitted. Path addressing and an explicit
 * endpoint are the assumptions that hold for the widest set of unknown
 * S3-compatible servers; `casWildcard: true` because every store except MinIO
 * supports the wildcard today, and MinIO users name their provider.
 */
const GENERIC_PRESET: ProviderPreset = {
	endpoint: () => {
		throw new Error(
			`store.endpoint is required when store.provider is not set. Either name a provider ("aws" | "r2" | "tigris" | "minio" | "gcs") so the endpoint can be derived, or pass the endpoint URL explicitly.`,
		);
	},
	region: "auto",
	urlStyle: "path",
	casWildcard: true,
	batchDelete: true,
};

// ── config ────────────────────────────────────────────────────────────────

export interface S3DriverConfig extends StoreConfig {
	/**
	 * TEST-ONLY transport override. Lets a test stub S3 without a network and
	 * assert on the exact signed request. Not part of the public configuration
	 * surface; production always uses global `fetch`.
	 *
	 * @internal
	 */
	fetch?: typeof fetch;
	/**
	 * TEST-ONLY clock, threaded into `signRequest` so a test can pin `x-amz-date`
	 * and assert a byte-exact `Authorization` header.
	 *
	 * @internal
	 */
	now?: () => Date;
	/**
	 * TEST-ONLY sleep, so retry backoff does not burn wall-clock in the suite.
	 *
	 * @internal
	 */
	sleep?: (ms: number) => Promise<void>;
}

// ── retry policy ──────────────────────────────────────────────────────────

/**
 * The whole retry policy, in one place: retry 5xx, 429 and transport errors.
 * Nothing else.
 *
 * A 412 or 409 is NEVER retried, and that is the load-bearing rule. Those codes
 * mean a conditional write lost a race — someone else wrote the lease or the
 * manifest first. Retrying re-sends the SAME `If-Match` etag, which is now
 * provably stale, so the retry either fails identically (wasted round trips) or,
 * far worse, succeeds against a store with weaker semantics and clobbers the
 * winner's write. The only correct response is to surface it, let the caller
 * re-read, and decide again. `PreconditionFailedError` exists to make that
 * unmissable.
 *
 * Other 4xx are not retried either: 403 (bad credentials, clock skew), 404 and
 * 400 are all deterministic. Retrying them only delays the real error.
 *
 * `null` means the request never produced a response — DNS, TCP, TLS, abort.
 * Those are retried, which is safe for every operation here: GET and DELETE are
 * naturally idempotent, and a PUT either carries a conditional header (so a
 * duplicate is rejected) or targets a write-once WAL key whose name already
 * contains the fencing epoch and sequence.
 */
function isRetryable(status: number | null): boolean {
	if (status === null) return true;
	if (status === 412 || status === 409) return false;
	if (status === 429) return true;
	return status >= 500;
}

/** Exponential backoff with full jitter — the AWS-recommended curve. */
function retryDelayMs(attempt: number, response: Response | null): number {
	const retryAfter = response?.headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
		}
	}
	// Full jitter rather than a fixed backoff: N writers that all hit the same
	// 503 would otherwise retry in lockstep and reproduce the overload.
	return Math.random() * RETRY_BASE_MS * 2 ** attempt;
}

// ── XML (small, deliberate, dependency-free) ──────────────────────────────

const CONTENTS_RE = /<Contents>([\s\S]*?)<\/Contents>/g;
const KEY_RE = /<Key>([\s\S]*?)<\/Key>/;
const SIZE_RE = /<Size>\s*(\d+)\s*<\/Size>/;
const TRUNCATED_RE = /<IsTruncated>\s*true\s*<\/IsTruncated>/i;
const NEXT_TOKEN_RE = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/;
const DELETE_ERROR_RE = /<Error>([\s\S]*?)<\/Error>/g;
const CODE_RE = /<Code>([\s\S]*?)<\/Code>/;
const MESSAGE_RE = /<Message>([\s\S]*?)<\/Message>/;

/**
 * Unescapes XML entities in a text node. S3 escapes `& < > " '` in keys, so a
 * key containing `&` comes back as `&amp;` and would otherwise be reported —
 * and later deleted — under the wrong name.
 *
 * Keys carrying characters that are illegal in XML (control bytes) would need
 * `encoding-type=url` on the request and a `decodeURIComponent` here. reflectdb's
 * own layout (`_lease`, `_manifest`, `wal/<epoch>-<seq>.jsonl`, `snap/<hlc>.json`)
 * never produces one, so that complexity is deliberately not carried.
 */
function xmlUnescape(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (entity, name: string) => {
		switch (name) {
			case "amp":
				return "&";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			default: {
				const code = name.startsWith("#x")
					? Number.parseInt(name.slice(2), 16)
					: Number.parseInt(name.slice(1), 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
			}
		}
	});
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

// ── CRC32 (for the DeleteObjects checksum) ────────────────────────────────

let crcTable: Uint32Array | undefined;

/**
 * `DeleteObjects` is the one S3 call that rejects an unchecksummed body: AWS
 * requires either `Content-MD5` or an `x-amz-checksum-*` header. MD5 is not in
 * WebCrypto and implementing it here would be silly, so we send CRC32 — which
 * is what current AWS SDKs send by default and what R2, Tigris and MinIO all
 * accept. Twenty lines beats a dependency or a hand-rolled MD5.
 */
function crc32(bytes: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let value = i;
			for (let bit = 0; bit < 8; bit++) {
				value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
			}
			crcTable[i] = value >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function base64Crc32(bytes: Uint8Array): string {
	const crc = crc32(bytes);
	return btoa(
		String.fromCharCode((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff),
	);
}

/**
 * Serialises query params for the wire. Deliberately NOT `URLSearchParams`,
 * which encodes a space as `+`; SigV4 requires `%20` and S3 does not treat `+`
 * as a space when it verifies, so a prefix containing a space would sign one
 * string and send another.
 *
 * Valueless subresources keep their bare form — `?delete`, not `?delete=` —
 * matching what every AWS SDK puts on the wire. The signature is unaffected:
 * the signer re-derives the canonical query from `url.searchParams`, which
 * parses both forms to an empty value and canonicalises both to `delete=`.
 */
function searchString(query: readonly (readonly [string, string])[]): string {
	return [...query]
		.map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([key, value]) => (value === "" ? key : `${key}=${value}`))
		.join("&");
}

// ── the driver ────────────────────────────────────────────────────────────

interface RequestSpec {
	method: string;
	url: URL;
	headers?: Record<string, string>;
	body?: Uint8Array;
}

export function createS3Driver(config: S3DriverConfig): ObjectDriver {
	const preset = config.provider ? PROVIDER_PRESETS[config.provider] : GENERIC_PRESET;
	const providerName = config.provider ?? "custom";

	const region = config.region ?? preset.region;
	const urlStyle = config.urlStyle ?? preset.urlStyle;
	// Explicit config always wins over the preset, so the preset's endpoint
	// factory (which may throw) is only consulted when nothing was given.
	const endpoint = parseEndpoint(config.endpoint ?? preset.endpoint(config));
	const bucket = config.bucket;
	const credentials = config.credentials;
	const doFetch = config.fetch ?? globalThis.fetch;
	const now = config.now ?? (() => new Date());
	const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const caps: ObjectDriverCapabilities = { casWildcard: preset.casWildcard };

	// Leading and trailing slashes stripped once, so key joining is a plain
	// concat and never produces the `a//b` that S3 would treat as a real key
	// with an empty segment.
	const prefixRoot = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");

	function toStoreKey(key: string): string {
		const trimmed = key.replace(/^\/+/, "");
		return prefixRoot ? `${prefixRoot}/${trimmed}` : trimmed;
	}

	/** Strips `config.prefix` so callers only ever see store-relative keys. */
	function fromStoreKey(key: string): string {
		if (!prefixRoot) return key;
		return key.startsWith(`${prefixRoot}/`) ? key.slice(prefixRoot.length + 1) : key;
	}

	/**
	 * Builds the request URL. `key === null` addresses the bucket itself (list,
	 * batch delete).
	 *
	 * The path is percent-encoded with the SAME function the signer uses to build
	 * the canonical URI, and the signer then reads `url.pathname` verbatim. That
	 * identity is not decoration: if the fetched path and the signed path differ
	 * by one character, S3 answers 403 `SignatureDoesNotMatch` with no hint about
	 * which part disagreed.
	 */
	function buildUrl(key: string | null, query: readonly (readonly [string, string])[] = []): URL {
		// vhost → https://<bucket>.<host>/<key>; path → https://<host>/<bucket>/<key>
		const host = urlStyle === "vhost" ? `${bucket}.${endpoint.host}` : endpoint.host;
		let path = endpoint.basePath;
		if (urlStyle === "path") path += `/${encodeUriPath(bucket)}`;
		if (key !== null) path += `/${encodeUriPath(toStoreKey(key))}`;
		const url = new URL(`${endpoint.protocol}//${host}${path || "/"}`);
		if (query.length > 0) url.search = searchString(query);
		return url;
	}

	/**
	 * Signs and sends, retrying per `isRetryable`.
	 *
	 * Signing happens INSIDE the loop. `x-amz-date` is part of the signature and
	 * S3 rejects a request whose timestamp is more than 15 minutes off, so a
	 * signature computed once and reused across a long backoff would eventually
	 * start failing with `RequestTimeTooSkewed` — a "transient" error that never
	 * clears. Re-signing each attempt costs two HMACs.
	 */
	async function send(spec: RequestSpec): Promise<Response> {
		let lastError: unknown;
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				const headers = await signRequest({
					method: spec.method,
					url: spec.url,
					headers: spec.headers ?? {},
					body: spec.body,
					region,
					service: "s3",
					credentials,
					now: now(),
				});
				response = await doFetch(spec.url.toString(), {
					method: spec.method,
					headers,
					// A plain byte view, never a stream: a stream is consumed by the
					// first attempt and would make the request unrepeatable on retry.
					body: spec.body as BodyInit | undefined,
				});
			} catch (error) {
				lastError = error;
				if (attempt >= MAX_RETRIES) {
					throw new Error(
						`S3 ${spec.method} ${spec.url.pathname} failed after ${attempt + 1} attempts: ${String(error)}`,
						{ cause: lastError },
					);
				}
				await sleep(retryDelayMs(attempt, null));
				continue;
			}

			if (response.ok || !isRetryable(response.status) || attempt >= MAX_RETRIES) return response;
			// Drain the body before discarding the response so the connection can be
			// reused rather than left half-read.
			await response.text().catch(() => "");
			await sleep(retryDelayMs(attempt, response));
		}
	}

	async function failure(operation: string, subject: string, response: Response): Promise<Error> {
		const body = await response.text().catch(() => "");
		const detail = body.trim().slice(0, 512);
		return new Error(
			`S3 ${operation} failed for "${subject}": ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`,
		);
	}

	async function deleteBatch(keys: string[]): Promise<void> {
		const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys
			.map((key) => `<Object><Key>${xmlEscape(toStoreKey(key))}</Key></Object>`)
			.join("")}</Delete>`;
		const body = textEncoder.encode(xml);
		const response = await send({
			method: "POST",
			url: buildUrl(null, [["delete", ""]]),
			headers: {
				"content-type": "application/xml",
				"x-amz-sdk-checksum-algorithm": "CRC32",
				"x-amz-checksum-crc32": base64Crc32(body),
			},
			body,
		});
		if (!response.ok) throw await failure("DELETE (batch)", keys[0] ?? "", response);

		// `Quiet` suppresses the per-key success entries, so anything left in the
		// document is a real failure. Missing keys are NOT reported here — S3
		// treats deleting an absent key as success, which is exactly the contract
		// `ObjectDriver.delete` promises.
		const text = await response.text();
		const failures = [...text.matchAll(DELETE_ERROR_RE)].map((match) => {
			const block = match[1] ?? "";
			const key = xmlUnescape(KEY_RE.exec(block)?.[1] ?? "?");
			const code = CODE_RE.exec(block)?.[1] ?? "Unknown";
			const message = MESSAGE_RE.exec(block)?.[1] ?? "";
			return `${key}: ${code}${message ? ` (${message})` : ""}`;
		});
		if (failures.length > 0) {
			throw new Error(
				`S3 batch delete reported ${failures.length} failure(s) — ${failures.join("; ")}`,
			);
		}
	}

	/** One request per key, for stores without the multi-object delete API (GCS). */
	async function deleteIndividually(keys: string[]): Promise<void> {
		for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
			const window = keys.slice(i, i + DELETE_CONCURRENCY);
			await Promise.all(
				window.map(async (key) => {
					const response = await send({ method: "DELETE", url: buildUrl(key) });
					// 204 is the success code; 404 means it was already gone, which the
					// driver contract says is not an error.
					if (response.ok || response.status === 404) {
						await response.text().catch(() => "");
						return;
					}
					throw await failure("DELETE", key, response);
				}),
			);
		}
	}

	return {
		caps,

		async get(key: string): Promise<ObjectRecord | null> {
			const response = await send({ method: "GET", url: buildUrl(key) });
			// Absence is not an error. Note that S3 answers 403 rather than 404 for a
			// missing object when the caller lacks `s3:ListBucket` — that stays a
			// throw, because silently reporting "absent" on a permissions problem
			// would let the adapter conclude the room has no lease and elect itself
			// writer.
			if (response.status === 404) {
				await response.text().catch(() => "");
				return null;
			}
			if (!response.ok) throw await failure("GET", key, response);
			const etag = response.headers.get("etag");
			if (!etag) {
				throw new Error(
					`S3 GET of "${key}" returned no ETag header. The etag is the CAS token for every later conditional write, so continuing without one would turn a lost race into a silent overwrite.`,
				);
			}
			// Verbatim, quotes included: `If-Match` must echo exactly what the store
			// sent, and stripping the quotes here breaks the compare on every store.
			return { body: new Uint8Array(await response.arrayBuffer()), etag };
		},

		async put(key: string, body: Uint8Array, opts?: ObjectPutOptions): Promise<string> {
			if (opts?.ifNoneMatch === "*" && !caps.casWildcard) {
				// A PLAIN Error, never PreconditionFailedError. The two are read very
				// differently: `PreconditionFailedError` means "you lost a race, re-read
				// and try again", and a caller that retried this forever would spin
				// against a store that can never satisfy it. This is a configuration
				// fault and has to look like one.
				throw new Error(
					`Provider "${providerName}" does not support create-if-absent (If-None-Match: *); it requires an exact etag. Seed "_lease" and "_manifest" once with init() as a deploy step — not from N racing servers — after which every write is a plain ifMatch, which this store handles fine. See docs/object-storage.md, "The MinIO gotcha".`,
				);
			}

			const headers: Record<string, string> = {};
			if (opts?.ifMatch) headers["if-match"] = opts.ifMatch;
			if (opts?.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;

			const response = await send({ method: "PUT", url: buildUrl(key), headers, body });
			// 412 is the standard conditional-write failure. Some S3-compatible
			// stores answer 409 Conflict for the same situation (two conditional
			// writes racing on the same key), so both map to the same error — the
			// caller must re-read either way.
			if (response.status === 412 || response.status === 409) {
				await response.text().catch(() => "");
				throw new PreconditionFailedError(key);
			}
			if (!response.ok) throw await failure("PUT", key, response);
			const etag = response.headers.get("etag");
			if (!etag) {
				throw new Error(
					`S3 PUT of "${key}" returned no ETag header, so the next conditional write has nothing to CAS against.`,
				);
			}
			await response.text().catch(() => "");
			return etag;
		},

		async list(prefix: string): Promise<ObjectListEntry[]> {
			const fullPrefix = prefixRoot
				? prefix
					? `${prefixRoot}/${prefix.replace(/^\/+/, "")}`
					: `${prefixRoot}/`
				: prefix.replace(/^\/+/, "");
			const entries: ObjectListEntry[] = [];
			let continuationToken: string | undefined;

			// ListObjectsV2 caps at 1000 keys per response; page until the store says
			// it is done. Returning a partial listing would make WAL replay skip
			// segments, so there is no early exit here.
			do {
				const query: [string, string][] = [["list-type", "2"]];
				if (fullPrefix) query.push(["prefix", fullPrefix]);
				if (continuationToken) query.push(["continuation-token", continuationToken]);

				const response = await send({ method: "GET", url: buildUrl(null, query) });
				if (!response.ok) throw await failure("LIST", fullPrefix, response);
				const xml = await response.text();

				for (const match of xml.matchAll(CONTENTS_RE)) {
					const block = match[1] ?? "";
					const rawKey = KEY_RE.exec(block)?.[1];
					if (rawKey === undefined) continue;
					entries.push({
						key: fromStoreKey(xmlUnescape(rawKey)),
						size: Number(SIZE_RE.exec(block)?.[1] ?? 0),
					});
				}

				if (TRUNCATED_RE.test(xml)) {
					continuationToken = xmlUnescape(NEXT_TOKEN_RE.exec(xml)?.[1] ?? "");
					if (!continuationToken) {
						// Truncated with no token is a malformed response. Looping would
						// re-request page one forever.
						throw new Error(
							`S3 LIST of "${fullPrefix}" reported IsTruncated with no NextContinuationToken; refusing to loop on a malformed response.`,
						);
					}
				} else {
					continuationToken = undefined;
				}
			} while (continuationToken);

			// Explicit sort, and by code unit rather than `localeCompare`. S3 already
			// returns keys in lexicographic order, but that guarantee is per-response
			// and the driver's contract is a single ordered set — WAL replay applies
			// segments in the order this array gives them, so a locale-dependent or
			// provider-dependent order would replay a room's history differently on
			// two machines.
			entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
			return entries;
		},

		async delete(keys: string[]): Promise<void> {
			if (keys.length === 0) return;
			if (!preset.batchDelete) return deleteIndividually(keys);
			for (let i = 0; i < keys.length; i += MAX_KEYS_PER_DELETE) {
				await deleteBatch(keys.slice(i, i + MAX_KEYS_PER_DELETE));
			}
		},
	};
}

// ── endpoint parsing ──────────────────────────────────────────────────────

interface ParsedEndpoint {
	/** Includes the trailing colon, e.g. `"https:"`. */
	protocol: string;
	/** Host with any explicit port — SigV4 signs `host` byte-for-byte. */
	host: string;
	/** Already-encoded path prefix with no trailing slash; `""` for a bare origin. */
	basePath: string;
}

function parseEndpoint(raw: string): ParsedEndpoint {
	// Accept both "t3.storage.dev" and "https://t3.storage.dev". A bare host is
	// what people copy out of provider dashboards, and defaulting it to https
	// beats a `TypeError: Invalid URL` three layers down.
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error(`store.endpoint is not a valid URL: ${JSON.stringify(raw)}`);
	}
	return {
		protocol: url.protocol,
		host: url.host,
		// Some self-hosted MinIO deployments sit behind a path prefix. Keep it (the
		// URL parser has already encoded it) and strip trailing slashes so key
		// joining stays a plain concat.
		basePath: url.pathname.replace(/\/+$/, ""),
	};
}
