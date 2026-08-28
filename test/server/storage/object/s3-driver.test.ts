import { describe, expect, test } from "bun:test";
import {
	PROVIDER_PRESETS,
	createS3Driver,
} from "../../../../src/server/storage/object/drivers/s3.ts";
import type { StoreConfig } from "../../../../src/server/storage/object/types.ts";
import { PreconditionFailedError } from "../../../../src/server/storage/object/types.ts";

/**
 * The S3 driver is exercised against a stubbed `fetch` rather than a bucket: the
 * things worth pinning are which URL was built, which headers were signed, and
 * which HTTP status maps to which error class — all of which a real bucket would
 * make slower and non-deterministic to assert.
 *
 * `sigv4.test.ts` covers signature correctness itself against an independent
 * implementation.
 */

const CREDENTIALS = { keyId: "AKIDEXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const NOW = () => new Date("2015-08-30T12:36:00Z");

interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
}

/** Queue of canned responses; each request pops the next one. */
function stub(responses: (Response | Error)[]) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : null;
		const url = request ? request.url : String(input);
		const headers: Record<string, string> = {};
		new Headers(request ? request.headers : init?.headers).forEach((value, key) => {
			headers[key] = value;
		});
		const raw = (request ? undefined : init?.body) as Uint8Array | string | undefined;
		calls.push({
			method: (request?.method ?? init?.method ?? "GET").toUpperCase(),
			url,
			headers,
			body:
				raw === undefined
					? ""
					: typeof raw === "string"
						? raw
						: new TextDecoder().decode(raw),
		});
		const next = responses.shift();
		if (!next) throw new Error(`stub fetch: unexpected extra call to ${url}`);
		if (next instanceof Error) throw next;
		return next;
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

function xml(body: string, init?: ResponseInit) {
	return new Response(body, { status: 200, ...init });
}

function driverFor(config: Partial<StoreConfig>, responses: (Response | Error)[]) {
	const { fetchImpl, calls } = stub(responses);
	const driver = createS3Driver({
		bucket: "my-bucket",
		credentials: CREDENTIALS,
		...config,
		fetch: fetchImpl,
		now: NOW,
		sleep: async () => {},
	});
	return { driver, calls };
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("s3 driver: provider presets", () => {
	test("MinIO reports no wildcard CAS; the others do", () => {
		expect(PROVIDER_PRESETS.minio.casWildcard).toBe(false);
		for (const name of ["aws", "r2", "tigris", "gcs"] as const) {
			expect(PROVIDER_PRESETS[name].casWildcard).toBe(true);
		}
	});

	test("MinIO and GCS use path addressing; AWS, R2 and Tigris use vhost", () => {
		expect(PROVIDER_PRESETS.minio.urlStyle).toBe("path");
		expect(PROVIDER_PRESETS.gcs.urlStyle).toBe("path");
		for (const name of ["aws", "r2", "tigris"] as const) {
			expect(PROVIDER_PRESETS[name].urlStyle).toBe("vhost");
		}
	});

	test("R2 without an accountId fails with an actionable message", () => {
		expect(() =>
			createS3Driver({ provider: "r2", bucket: "b", credentials: CREDENTIALS }),
		).toThrow("store.accountId is required");
	});

	test("MinIO without an endpoint fails with an actionable message", () => {
		expect(() =>
			createS3Driver({ provider: "minio", bucket: "b", credentials: CREDENTIALS }),
		).toThrow("store.endpoint is required");
	});

	test("no provider and no endpoint fails rather than guessing", () => {
		expect(() => createS3Driver({ bucket: "b", credentials: CREDENTIALS })).toThrow(
			"store.endpoint is required",
		);
	});
});

describe("s3 driver: URL construction", () => {
	test("vhost addressing puts the bucket in the host", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [xml("hi", { headers: { etag: '"e"' } })]);
		await driver.get("rooms/r1/_manifest");
		expect(calls[0]!.url).toBe("https://my-bucket.t3.storage.dev/rooms/r1/_manifest");
	});

	test("path addressing puts the bucket in the path", async () => {
		const { driver, calls } = driverFor(
			{ provider: "minio", endpoint: "http://localhost:9000" },
			[xml("hi", { headers: { etag: '"e"' } })],
		);
		await driver.get("rooms/r1/_manifest");
		expect(calls[0]!.url).toBe("http://localhost:9000/my-bucket/rooms/r1/_manifest");
	});

	test("prefix is applied to the key", async () => {
		const { driver, calls } = driverFor(
			{ provider: "tigris", prefix: "reflectdb" },
			[xml("hi", { headers: { etag: '"e"' } })],
		);
		await driver.get("rooms/r1/_lease");
		expect(calls[0]!.url).toBe("https://my-bucket.t3.storage.dev/reflectdb/rooms/r1/_lease");
	});

	test("key characters are percent-encoded, separators are not", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [
			xml("hi", { headers: { etag: '"e"' } }),
		]);
		await driver.get("rooms/a b/c$d");
		expect(calls[0]!.url).toBe("https://my-bucket.t3.storage.dev/rooms/a%20b/c%24d");
	});

	test("every request carries a SigV4 Authorization header", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [
			xml("hi", { headers: { etag: '"e"' } }),
		]);
		await driver.get("k");
		expect(calls[0]!.headers.authorization).toStartWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/");
		expect(calls[0]!.headers["x-amz-date"]).toBe("20150830T123600Z");
	});
});

describe("s3 driver: get", () => {
	test("200 returns the body and the etag verbatim", async () => {
		const { driver } = driverFor({ provider: "tigris" }, [
			xml("payload", { headers: { etag: '"abc123"' } }),
		]);
		const got = await driver.get("k");
		expect(new TextDecoder().decode(got!.body)).toBe("payload");
		// Quotes preserved: a caller round-trips this into If-Match unchanged.
		expect(got!.etag).toBe('"abc123"');
	});

	test("404 returns null rather than throwing — absence is not an error", async () => {
		const { driver } = driverFor({ provider: "tigris" }, [new Response("", { status: 404 })]);
		expect(await driver.get("missing")).toBeNull();
	});

	test("an unexpected status throws with the status in the message", async () => {
		const { driver } = driverFor({ provider: "tigris" }, [
			new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
		]);
		await expect(driver.get("k")).rejects.toThrow(/403/);
	});
});

describe("s3 driver: conditional writes", () => {
	test("ifMatch is sent as the If-Match header", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [
			new Response("", { status: 200, headers: { etag: '"new"' } }),
		]);
		const etag = await driver.put("k", utf8("v"), { ifMatch: '"old"' });
		expect(calls[0]!.headers["if-match"]).toBe('"old"');
		expect(etag).toBe('"new"');
	});

	test("ifNoneMatch is sent as If-None-Match: *", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [
			new Response("", { status: 200, headers: { etag: '"new"' } }),
		]);
		await driver.put("k", utf8("v"), { ifNoneMatch: "*" });
		expect(calls[0]!.headers["if-none-match"]).toBe("*");
	});

	test("412 becomes PreconditionFailedError", async () => {
		const { driver } = driverFor({ provider: "tigris" }, [new Response("", { status: 412 })]);
		await expect(driver.put("k", utf8("v"), { ifMatch: '"old"' })).rejects.toBeInstanceOf(
			PreconditionFailedError,
		);
	});

	test("409 becomes PreconditionFailedError too — some stores return it instead", async () => {
		const { driver } = driverFor({ provider: "tigris" }, [new Response("", { status: 409 })]);
		await expect(driver.put("k", utf8("v"), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(
			PreconditionFailedError,
		);
	});

	test("a wildcard put against MinIO fails distinctly from a lost race", async () => {
		// Not a PreconditionFailedError: 412 means "re-read and back off", which an
		// election loop retries. "This store cannot create-if-absent" needs init().
		const { driver, calls } = driverFor(
			{ provider: "minio", endpoint: "http://localhost:9000" },
			[],
		);
		const error = await driver.put("k", utf8("v"), { ifNoneMatch: "*" }).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(PreconditionFailedError);
		expect((error as Error).message).toContain("init()");
		// It never reached the network.
		expect(calls.length).toBe(0);
	});
});

describe("s3 driver: retries", () => {
	test("a 500 is retried and can succeed", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [
			new Response("", { status: 500 }),
			new Response("", { status: 200, headers: { etag: '"ok"' } }),
		]);
		expect(await driver.put("k", utf8("v"))).toBe('"ok"');
		expect(calls.length).toBe(2);
	});

	test("a transport error is retried", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [
			new TypeError("fetch failed"),
			new Response("", { status: 200, headers: { etag: '"ok"' } }),
		]);
		expect(await driver.put("k", utf8("v"))).toBe('"ok"');
		expect(calls.length).toBe(2);
	});

	test("a 412 is NEVER retried — the stale etag would only lose again", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [new Response("", { status: 412 })]);
		await expect(driver.put("k", utf8("v"), { ifMatch: '"old"' })).rejects.toBeInstanceOf(
			PreconditionFailedError,
		);
		expect(calls.length).toBe(1);
	});

	test("a 403 is not retried — it is deterministic", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [new Response("", { status: 403 })]);
		await expect(driver.get("k")).rejects.toThrow();
		expect(calls.length).toBe(1);
	});

	test("retries are bounded and the final failure surfaces", async () => {
		const { driver, calls } = driverFor(
			{ provider: "tigris" },
			Array.from({ length: 8 }, () => new Response("", { status: 503 })),
		);
		await expect(driver.get("k")).rejects.toThrow(/503/);
		expect(calls.length).toBeGreaterThan(1);
		expect(calls.length).toBeLessThanOrEqual(5);
	});
});

describe("s3 driver: list", () => {
	const page = (keys: [string, number][], nextToken?: string) =>
		xml(
			`<ListBucketResult>${keys
				.map(([k, s]) => `<Contents><Key>${k}</Key><Size>${s}</Size></Contents>`)
				.join("")}${
				nextToken
					? `<IsTruncated>true</IsTruncated><NextContinuationToken>${nextToken}</NextContinuationToken>`
					: "<IsTruncated>false</IsTruncated>"
			}</ListBucketResult>`,
		);

	test("parses keys and sizes and sorts ascending", async () => {
		const { driver } = driverFor({ provider: "tigris" }, [
			page([
				["wal/1-9", 9],
				["wal/1-10", 10],
				["wal/1-1", 1],
			]),
		]);
		expect(await driver.list("wal/")).toEqual([
			{ key: "wal/1-1", size: 1 },
			{ key: "wal/1-10", size: 10 },
			{ key: "wal/1-9", size: 9 },
		]);
	});

	test("follows continuation tokens until IsTruncated is false", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [
			page([["wal/1-1", 1]], "TOKEN-A"),
			page([["wal/1-2", 2]]),
		]);
		expect((await driver.list("wal/")).map((e) => e.key)).toEqual(["wal/1-1", "wal/1-2"]);
		expect(calls.length).toBe(2);
		expect(calls[1]!.url).toContain("continuation-token=TOKEN-A");
	});

	test("XML-unescapes keys so they are usable for get and delete", async () => {
		const { driver } = driverFor({ provider: "tigris" }, [page([["a&amp;b/c&lt;d", 1]])]);
		expect((await driver.list(""))[0]!.key).toBe("a&b/c<d");
	});

	test("strips the configured prefix so callers see store-relative keys", async () => {
		const { driver, calls } = driverFor({ provider: "tigris", prefix: "reflectdb" }, [
			page([["reflectdb/wal/1-1", 1]]),
		]);
		expect((await driver.list("wal/"))[0]!.key).toBe("wal/1-1");
		expect(calls[0]!.url).toContain(`prefix=${encodeURIComponent("reflectdb/wal/")}`);
	});

	test("an empty result is an empty array", async () => {
		const { driver } = driverFor({ provider: "tigris" }, [page([])]);
		expect(await driver.list("nothing/")).toEqual([]);
	});
});

describe("s3 driver: delete", () => {
	test("uses the batch DeleteObjects API with a checksum", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [
			xml("<DeleteResult></DeleteResult>"),
		]);
		await driver.delete(["wal/1-1", "wal/1-2"]);
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.url).toContain("delete");
		expect(calls[0]!.body).toContain("<Key>wal/1-1</Key>");
		expect(calls[0]!.body).toContain("<Key>wal/1-2</Key>");
		// S3 rejects an unchecksummed DeleteObjects body.
		const hasChecksum = Object.keys(calls[0]!.headers).some(
			(h) => h === "content-md5" || h.startsWith("x-amz-checksum-"),
		);
		expect(hasChecksum).toBe(true);
	});

	test("XML-escapes keys in the request body", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, [
			xml("<DeleteResult></DeleteResult>"),
		]);
		await driver.delete(["a&b"]);
		expect(calls[0]!.body).toContain("<Key>a&amp;b</Key>");
	});

	test("GCS falls back to one DELETE per key", async () => {
		// Google's XML API has no multi-object delete.
		const { driver, calls } = driverFor({ provider: "gcs" }, [
			new Response("", { status: 204 }),
			new Response("", { status: 204 }),
		]);
		await driver.delete(["a", "b"]);
		expect(calls.map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
	});

	test("an empty key list makes no request", async () => {
		const { driver, calls } = driverFor({ provider: "tigris" }, []);
		await driver.delete([]);
		expect(calls.length).toBe(0);
	});

	test("a per-key error in the batch response surfaces", async () => {
		const { driver } = driverFor({ provider: "tigris" }, [
			xml(
				"<DeleteResult><Error><Key>a</Key><Code>AccessDenied</Code><Message>nope</Message></Error></DeleteResult>",
			),
		]);
		await expect(driver.delete(["a"])).rejects.toThrow(/AccessDenied/);
	});
});
