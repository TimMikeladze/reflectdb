import { describe, expect, test } from "bun:test";
import {
	EMPTY_PAYLOAD_SHA256,
	canonicalHeaders,
	canonicalQueryString,
	deriveSigningKey,
	encodeUriPath,
	formatAmzDate,
	hexSha256,
	percentEncode,
	signRequest,
} from "../../../../src/server/storage/object/sigv4.ts";

/**
 * A wrong SigV4 signature fails with `SignatureDoesNotMatch` and no indication
 * of which of the six canonical-request lines differed, so these tests pin the
 * signer against known-good output rather than against itself.
 *
 * Provenance of the expected values: an independent SigV4 implementation was
 * written in Python (hashlib/hmac only, no shared code with the TypeScript
 * signer) and first validated against AWS's published `get-vanilla` vector from
 * the aws-sig-v4-test-suite — key `AKIDEXAMPLE`, secret
 * `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`, `20150830T123600Z`,
 * `us-east-1/service`, expected signature
 * `5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`. It
 * reproduced that exactly, and was then used to generate the vectors below for
 * the request shapes this driver actually issues. Two independent
 * implementations agreeing on seven cases is the check; neither was derived
 * from the other.
 *
 * `get-vanilla` itself is not reproducible through `signRequest` because this
 * signer always adds `x-amz-content-sha256` (S3 requires it), which changes
 * `SignedHeaders` and therefore the signature. The primitive-level tests below
 * cover the pieces that vector exercises.
 */

const KEY_ID = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const NOW = new Date("2015-08-30T12:36:00Z");

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("sigv4 primitives", () => {
	test("percentEncode escapes everything outside the RFC 3986 unreserved set", () => {
		expect(percentEncode("abcXYZ019-._~")).toBe("abcXYZ019-._~");
		// The characters encodeURIComponent leaves alone but AWS does not. Getting
		// these wrong is a 403 with an unhelpful message.
		expect(percentEncode("!'()*")).toBe("%21%27%28%29%2A");
		expect(percentEncode("/")).toBe("%2F");
		expect(percentEncode(" ")).toBe("%20");
		expect(percentEncode("+")).toBe("%2B");
		expect(percentEncode("=")).toBe("%3D");
	});

	test("percentEncode uses uppercase hex and encodes UTF-8 bytes", () => {
		expect(percentEncode("é")).toBe("%C3%A9");
		expect(percentEncode("日")).toBe("%E6%97%A5");
	});

	test("encodeUriPath encodes segments but leaves the separators alone", () => {
		expect(encodeUriPath("/rooms/a b/c$d")).toBe("/rooms/a%20b/c%24d");
		// S3 keys are opaque byte strings: `a//b` and `a/../b` are distinct
		// objects, so the path is neither normalized nor double-encoded.
		expect(encodeUriPath("/a//b")).toBe("/a//b");
		expect(encodeUriPath("/a/../b")).toBe("/a/../b");
	});

	test("canonicalQueryString sorts by encoded key then value and always emits =", () => {
		expect(canonicalQueryString([["delete", ""]])).toBe("delete=");
		expect(
			canonicalQueryString([
				["prefix", "rooms/r1/"],
				["list-type", "2"],
			]),
		).toBe("list-type=2&prefix=rooms%2Fr1%2F");
		expect(
			canonicalQueryString([
				["a", "2"],
				["a", "1"],
			]),
		).toBe("a=1&a=2");
	});

	test("canonicalHeaders lowercases, trims, collapses whitespace and sorts", () => {
		const { canonical, signedHeaders } = canonicalHeaders({
			"X-Amz-Date": "20150830T123600Z",
			Host: "example.amazonaws.com",
			"If-Match": '  "a"   "b"  ',
		});
		expect(signedHeaders).toBe("host;if-match;x-amz-date");
		expect(canonical).toBe(
			'host:example.amazonaws.com\nif-match:"a" "b"\nx-amz-date:20150830T123600Z\n',
		);
	});

	test("hexSha256 matches the well-known empty-payload constant", async () => {
		expect(await hexSha256(new Uint8Array())).toBe(EMPTY_PAYLOAD_SHA256);
		expect(await hexSha256("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	test("formatAmzDate emits YYYYMMDD'T'HHMMSS'Z' in UTC", () => {
		expect(formatAmzDate(NOW)).toBe("20150830T123600Z");
		expect(formatAmzDate(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
	});

	test("deriveSigningKey reproduces the AWS worked example", async () => {
		// From the SigV4 documentation's signing-key walkthrough.
		const key = await deriveSigningKey(SECRET, "20150830", "us-east-1", "iam");
		const hex = [...key].map((b) => b.toString(16).padStart(2, "0")).join("");
		expect(hex).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
	});
});

describe("signRequest", () => {
	/** Every vector below was produced by the independent reference described above. */
	const vectors: {
		name: string;
		method: string;
		url: string;
		headers?: Record<string, string>;
		body?: string;
		region?: string;
		sessionToken?: string;
		authorization: string;
	}[] = [
		{
			name: "GET with no body",
			method: "GET",
			url: "https://bucket.s3.us-east-1.amazonaws.com/rooms/r1/_manifest",
			authorization:
				"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=91f057c4121fd112fbf5faeca0e2deeb604c11cf6eefbe64565b8c4629fe3341",
		},
		{
			name: "PUT with If-Match (the manifest CAS)",
			method: "PUT",
			url: "https://bucket.s3.us-east-1.amazonaws.com/rooms/r1/_manifest",
			headers: { "if-match": '"abc123"' },
			body: '{"version":1}',
			authorization:
				"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request, SignedHeaders=host;if-match;x-amz-content-sha256;x-amz-date, Signature=b57acd59f7a4490fc7f1929832e419539b6f758b01a0b97dbd61646877217649",
		},
		{
			name: "PUT with If-None-Match (create-if-absent)",
			method: "PUT",
			url: "https://bucket.s3.us-east-1.amazonaws.com/rooms/r1/_lease",
			headers: { "if-none-match": "*" },
			body: "seed",
			authorization:
				"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request, SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=aaa2e026450d9a4bf5d6ee1bdce885b1d41afd760d13e07907ef45835a45a8f5",
		},
		{
			name: "key with characters that must be escaped",
			method: "GET",
			url: `https://bucket.s3.us-east-1.amazonaws.com${encodeUriPath("/rooms/a b/c+d/e~f/g$h.txt")}`,
			authorization:
				"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=136043e772ec906eb824ab9e00eca18529713562952efbb083737344fa334fad",
		},
		{
			name: "ListObjectsV2 query string",
			method: "GET",
			url: `https://bucket.s3.us-east-1.amazonaws.com/?list-type=2&prefix=${percentEncode("rooms/r1/wal/")}&continuation-token=${percentEncode("a/b+c=")}`,
			authorization:
				"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=217f5e249fc2861a0d57659e4f3dc4374dec87e9bacd76486af6018a8a90373d",
		},
		{
			name: "path-style host with a port and a session token (MinIO)",
			method: "PUT",
			url: "https://minio.example.com:9000/mybucket/rooms/r1/wal/1-1.jsonl",
			body: "line\n",
			region: "auto",
			sessionToken: "SESSIONTOKEN",
			authorization:
				"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=e18a932477d9981ed0e107e703a17495101cfd3fa9233481086d108ead6e0ea6",
		},
		{
			name: "DeleteObjects POST with an empty-valued query param",
			method: "POST",
			url: "https://bucket.s3.us-east-1.amazonaws.com/?delete=",
			body: "<Delete><Object><Key>a</Key></Object></Delete>",
			authorization:
				"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=ec31e078c24de77af00329d6ef5d211951b01895ae11a3e8ad771c6319e57e33",
		},
	];

	for (const vector of vectors) {
		test(vector.name, async () => {
			const signed = await signRequest({
				method: vector.method,
				url: new URL(vector.url),
				headers: vector.headers ?? {},
				body: vector.body === undefined ? undefined : utf8(vector.body),
				region: vector.region ?? "us-east-1",
				service: "s3",
				credentials: { keyId: KEY_ID, secret: SECRET, sessionToken: vector.sessionToken },
				now: NOW,
			});
			expect(signed.authorization).toBe(vector.authorization);
		});
	}

	test("returns the complete header set, host included", async () => {
		const signed = await signRequest({
			method: "GET",
			url: new URL("https://bucket.s3.us-east-1.amazonaws.com/k"),
			headers: {},
			region: "us-east-1",
			service: "s3",
			credentials: { keyId: KEY_ID, secret: SECRET },
			now: NOW,
		});
		expect(signed.host).toBe("bucket.s3.us-east-1.amazonaws.com");
		expect(signed["x-amz-date"]).toBe("20150830T123600Z");
		expect(signed["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
		expect(signed["x-amz-security-token"]).toBeUndefined();
	});

	test("host keeps an explicit port — S3 verifies the header byte-for-byte", async () => {
		const signed = await signRequest({
			method: "GET",
			url: new URL("https://minio.example.com:9000/b/k"),
			headers: {},
			region: "auto",
			service: "s3",
			credentials: { keyId: KEY_ID, secret: SECRET },
			now: NOW,
		});
		expect(signed.host).toBe("minio.example.com:9000");
	});

	test("a body change changes the signature", async () => {
		const base = {
			method: "PUT",
			url: new URL("https://bucket.s3.us-east-1.amazonaws.com/k"),
			headers: {},
			region: "us-east-1",
			service: "s3",
			credentials: { keyId: KEY_ID, secret: SECRET },
			now: NOW,
		} as const;
		const a = await signRequest({ ...base, body: utf8("a") });
		const b = await signRequest({ ...base, body: utf8("b") });
		expect(a.authorization).not.toBe(b.authorization);
		expect(a["x-amz-content-sha256"]).not.toBe(b["x-amz-content-sha256"]);
	});
});
