/**
 * AWS Signature Version 4 request signing.
 *
 * Written by hand rather than pulled from `aws4fetch` or `@aws-sdk/*` for two
 * reasons. The server half of this package ships zero runtime dependencies, and
 * — more sharply — every published signer reaches for `node:crypto`. A `node:`
 * import anywhere under `src/` is fatal here: `bunup.config.ts` builds the whole
 * tree with `target: "browser"`, so Bun hoists the builtin into a shared chunk
 * that EVERY entry point side-effect-imports, `reflectdb/core` and
 * `reflectdb/react` included. Turbopack then refuses to build any consumer app.
 * See `src/server/node-require.ts` for the full autopsy.
 *
 * So SHA-256 and HMAC-SHA256 come from WebCrypto (`globalThis.crypto.subtle`),
 * which exists on Bun, Node >= 18, Cloudflare Workers, Deno and browsers, and
 * costs nothing in the module graph because it is a global rather than an
 * import. The one consequence worth knowing: WebCrypto's digest API is async,
 * so signing is async all the way up.
 *
 * This module is pure — no I/O, no ambient clock. `now` is injected so the
 * output is a deterministic function of the input, which is what lets the tests
 * run AWS's published SigV4 test-suite vectors against it.
 *
 * Reference: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-signing-process.html
 */

const ALGORITHM = "AWS4-HMAC-SHA256";

/**
 * Hex SHA-256 of the empty string. S3 requires `x-amz-content-sha256` on every
 * request, and this is the value for a GET/DELETE with no body. Hardcoded
 * because it is a well-known constant and hashing nothing on every request is
 * silly.
 */
export const EMPTY_PAYLOAD_SHA256 =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Characters RFC 3986 calls "unreserved" — the only ones left un-escaped. */
const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

const textEncoder = new TextEncoder();

// ── primitives ────────────────────────────────────────────────────────────

function subtle(): SubtleCrypto {
	const webCrypto = globalThis.crypto;
	if (!webCrypto?.subtle) {
		throw new Error(
			"The S3 driver needs WebCrypto (globalThis.crypto.subtle) to sign requests, and this runtime does not expose it. It is available on Bun, Node >= 18, Deno, Cloudflare Workers and browsers; on Node 18 outside a secure context it may need --experimental-global-webcrypto.",
		);
	}
	return webCrypto.subtle;
}

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

/** Hex-encoded SHA-256. Exported so the canonical-request tests can check hashes directly. */
export async function hexSha256(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
	return toHex(new Uint8Array(await subtle().digest("SHA-256", bytes as BufferSource)));
}

async function hmacSha256(key: Uint8Array, data: Uint8Array | string): Promise<Uint8Array> {
	const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
	const cryptoKey = await subtle().importKey(
		"raw",
		key as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await subtle().sign("HMAC", cryptoKey, bytes as BufferSource));
}

// ── canonicalization ──────────────────────────────────────────────────────

/**
 * Percent-encodes per RFC 3986: every byte outside the unreserved set becomes
 * `%XX` with UPPERCASE hex. Deliberately not `encodeURIComponent`, which leaves
 * `!'()*` unescaped — AWS escapes them, and a single character of disagreement
 * produces a 403 whose message tells you nothing.
 *
 * Note it encodes `/` too. Path encoding goes through `encodeUriPath`, which
 * splits on `/` first.
 */
export function percentEncode(value: string): string {
	let out = "";
	for (const byte of textEncoder.encode(value)) {
		const char = String.fromCharCode(byte);
		out +=
			byte < 0x80 && UNRESERVED.includes(char)
				? char
				: `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/**
 * Encodes a raw (unescaped) object path into the canonical URI form: each
 * segment percent-encoded, `/` left alone between segments.
 *
 * The `/` part is the single most common SigV4 bug. AWS's general canonical-URI
 * rule is "normalize the path, then URI-encode it a SECOND time", but S3 is
 * explicitly exempt: it encodes once and never normalizes, because an S3 key is
 * an opaque byte string in which `a/../b`, `a//b` and `a/./b` are three distinct
 * objects. Double-encoding here, or normalizing away a `..`, signs a path the
 * server never sees and yields `SignatureDoesNotMatch`.
 *
 * Callers MUST build the request URL with this function so `url.pathname` is
 * byte-identical to the canonical URI the signature covers. Letting the `URL`
 * constructor do the escaping instead is how the two drift apart.
 */
export function encodeUriPath(path: string): string {
	return path.split("/").map(percentEncode).join("/");
}

/**
 * Builds the canonical query string: both halves of every pair percent-encoded,
 * sorted by encoded key and then by encoded value, joined with `&`, and always
 * with an `=` — `?delete` canonicalizes to `delete=`, which is exactly what S3
 * does on its side.
 *
 * Sorting compares code units (`<`), never `localeCompare`: the latter is
 * locale-dependent and would sign a different order under a non-C locale.
 */
export function canonicalQueryString(params: Iterable<readonly [string, string]>): string {
	const encoded = [...params].map(
		([key, value]) => [percentEncode(key), percentEncode(value)] as const,
	);
	encoded.sort((a, b) => {
		if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
		if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
		return 0;
	});
	return encoded.map(([key, value]) => `${key}=${value}`).join("&");
}

/**
 * Lowercases header names, trims values and collapses internal whitespace runs
 * to a single space, then sorts by name. Returns both the canonical block and
 * the `;`-joined `SignedHeaders` list, which must agree exactly.
 *
 * (The spec exempts whitespace inside quoted strings from the collapse. No
 * header this driver sends — etags, `if-match`, `x-amz-*` — contains one, so
 * the simple collapse is safe here.)
 */
export function canonicalHeaders(headers: Record<string, string>): {
	canonical: string;
	signedHeaders: string;
} {
	const entries = Object.entries(headers)
		.map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return {
		canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
		signedHeaders: entries.map(([name]) => name).join(";"),
	};
}

export interface CanonicalRequestInput {
	method: string;
	/** Its `pathname` is used verbatim — build it with `encodeUriPath`. */
	url: URL;
	/** Every header that will be sent and signed, `host` included. */
	headers: Record<string, string>;
	/** Hex SHA-256 of the body, or `EMPTY_PAYLOAD_SHA256`. */
	payloadHash: string;
}

/**
 * The canonical request — the six-line document SigV4 actually hashes.
 * Exported on its own so tests can diff it against AWS's published vectors;
 * when a signature mismatches, this string is where the difference is.
 */
export function canonicalRequest(input: CanonicalRequestInput): {
	canonical: string;
	signedHeaders: string;
} {
	const { canonical: headerBlock, signedHeaders } = canonicalHeaders(input.headers);
	// `url.pathname` is already the encoded form (see `encodeUriPath`); re-encoding
	// it here would double-escape every `%` the caller wrote.
	const canonicalUri = input.url.pathname || "/";
	const canonical = [
		input.method.toUpperCase(),
		canonicalUri,
		canonicalQueryString(input.url.searchParams),
		headerBlock,
		signedHeaders,
		input.payloadHash,
	].join("\n");
	return { canonical, signedHeaders };
}

/** `YYYYMMDD'T'HHMMSS'Z'`, always UTC. */
export function formatAmzDate(now: Date): string {
	return now.toISOString().replace(/[:-]/g, "").replace(/\.\d+/, "");
}

/**
 * The signing key: four chained HMACs, each keyed by the previous result. The
 * chain is what scopes a signature to one day, one region and one service, so a
 * leaked signature cannot be replayed against a different bucket region.
 */
export async function deriveSigningKey(
	secret: string,
	dateStamp: string,
	region: string,
	service: string,
): Promise<Uint8Array> {
	const dateKey = await hmacSha256(textEncoder.encode(`AWS4${secret}`), dateStamp);
	const regionKey = await hmacSha256(dateKey, region);
	const serviceKey = await hmacSha256(regionKey, service);
	return hmacSha256(serviceKey, "aws4_request");
}

// ── the signer ────────────────────────────────────────────────────────────

export interface SignRequestInput {
	method: string;
	/** Built with `encodeUriPath` / `canonicalQueryString` — see those functions. */
	url: URL;
	/** Headers to sign and send. `host` is added automatically. */
	headers: Record<string, string>;
	/** Absent means an empty payload, hashed as `EMPTY_PAYLOAD_SHA256`. */
	body?: Uint8Array;
	region: string;
	/** `"s3"` for everything this driver does. */
	service: string;
	credentials: { keyId: string; secret: string; sessionToken?: string };
	/**
	 * Injected rather than read from `new Date()` so signing is deterministic and
	 * the test vectors can pin a timestamp.
	 */
	now: Date;
}

/**
 * Signs a request and returns the COMPLETE header set to send: the caller's own
 * headers (lowercased) plus `x-amz-date`, `x-amz-content-sha256`,
 * `x-amz-security-token` when the credentials carry one, and `authorization`.
 *
 * Send exactly these. Anything the HTTP client adds on its own
 * (`content-length`, `user-agent`) is fine because it is absent from
 * `SignedHeaders` and therefore outside the signature.
 */
export async function signRequest(input: SignRequestInput): Promise<Record<string, string>> {
	const { method, url, credentials, region, service, now } = input;

	// Step 1 — assemble the exact headers that will go on the wire. `host` is
	// always signed; without it a signature could be replayed against a different
	// bucket. `url.host` keeps any explicit port, which matters for MinIO on
	// :9000 — S3 verifies the header byte-for-byte.
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
	headers.host = url.host;

	// Step 2 — payload hash. It is both a signed header and the last line of the
	// canonical request, so it has to be computed before canonicalization.
	const payloadHash = input.body ? await hexSha256(input.body) : EMPTY_PAYLOAD_SHA256;
	headers["x-amz-content-sha256"] = payloadHash;

	const amzDate = formatAmzDate(now);
	headers["x-amz-date"] = amzDate;
	// Session tokens are signed, not just sent: STS binds the token to the
	// signature so a stolen token alone is useless.
	if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

	// Step 3 — canonical request, then hash it.
	const { canonical, signedHeaders } = canonicalRequest({ method, url, headers, payloadHash });

	// Step 4 — string to sign.
	const dateStamp = amzDate.slice(0, 8);
	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = [ALGORITHM, amzDate, scope, await hexSha256(canonical)].join("\n");

	// Step 5 — derive the key and sign.
	const signingKey = await deriveSigningKey(credentials.secret, dateStamp, region, service);
	const signature = toHex(await hmacSha256(signingKey, stringToSign));

	// Step 6 — the Authorization header. The `, ` separators and single space
	// after the algorithm are what AWS's own signers emit; S3 is lenient about
	// the spacing but nothing is gained by differing.
	headers.authorization = `${ALGORITHM} Credential=${credentials.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	return headers;
}
