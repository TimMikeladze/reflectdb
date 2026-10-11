import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { cloudflareTurn, sharedSecretTurn, staticIceServers } from "../../src/server/turn.ts";

const auth = { userId: "u-1" };

function fakeCloudflare(body: unknown, status = 201) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		await new Promise((r) => setTimeout(r, 10));
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

const CLOUDFLARE_RESPONSE = {
	iceServers: [
		{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
		{
			urls: [
				"turn:turn.cloudflare.com:3478?transport=udp",
				"turn:turn.cloudflare.com:53?transport=udp",
			],
			username: "gen-user",
			credential: "gen-pass",
		},
	],
};

describe("cloudflareTurn", () => {
	test("calls the generate-ice-servers endpoint and drops port-53 URLs browsers block", async () => {
		const { calls, fetchImpl } = fakeCloudflare(CLOUDFLARE_RESPONSE);
		const provider = cloudflareTurn({
			keyId: "key/1",
			apiToken: "secret",
			ttlSeconds: 600,
			fetch: fetchImpl,
		});

		const result = await provider({ auth });

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(
			"https://rtc.live.cloudflare.com/v1/turn/keys/key%2F1/credentials/generate-ice-servers",
		);
		expect(calls[0]!.init.method).toBe("POST");
		expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ttl: 600 });
		expect(result).toEqual({
			iceServers: [
				{ urls: ["stun:stun.cloudflare.com:3478"] },
				{
					urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
					username: "gen-user",
					credential: "gen-pass",
				},
			],
			ttlSeconds: 600,
		});
	});

	test("shares one credential across clients, and concurrent requests share one API call", async () => {
		const { calls, fetchImpl } = fakeCloudflare(CLOUDFLARE_RESPONSE);
		const provider = cloudflareTurn({
			keyId: "k",
			apiToken: "t",
			ttlSeconds: 600,
			fetch: fetchImpl,
		});

		await Promise.all([provider({ auth }), provider({ auth }), provider({ auth })]);
		const later = await provider({ auth: { userId: "u-2" } });

		expect(calls).toHaveLength(1);
		// A cached credential reports the time it has left, never more than its TTL.
		expect(later.ttlSeconds).toBeLessThanOrEqual(600);
	});

	test("a failed request throws without echoing the response body", async () => {
		const { fetchImpl } = fakeCloudflare({ error: "token abc123 is invalid" }, 401);
		const provider = cloudflareTurn({ keyId: "k", apiToken: "t", fetch: fetchImpl });

		const error = await Promise.resolve(provider({ auth })).catch((err: Error) => err);
		expect((error as Error).message).toBe("Cloudflare TURN credential request failed: HTTP 401");
	});
});

describe("sharedSecretTurn", () => {
	test("mints TURN REST-API credentials bound to the user", async () => {
		const provider = sharedSecretTurn({
			urls: ["turn:turn.example.com:3478"],
			secret: "s3cret",
			ttlSeconds: 3600,
			stun: ["stun:turn.example.com:3478"],
		});

		const result = await provider({ auth: { userId: "alice:admin" } });
		const turn = result.iceServers[1]!;
		const [expiry, user] = turn.username!.split(":");

		expect(result.iceServers[0]).toEqual({ urls: ["stun:turn.example.com:3478"] });
		expect(user).toBe("alice_admin");
		expect(Number(expiry) - Math.floor(Date.now() / 1000)).toBeGreaterThan(3590);
		// What coturn computes on its side for `use-auth-secret`.
		expect(turn.credential).toBe(
			createHmac("sha1", "s3cret").update(turn.username!).digest("base64"),
		);
		expect(result.ttlSeconds).toBe(3600);
	});
});

test("staticIceServers returns its list as is", async () => {
	const servers = [{ urls: "stun:stun.example.com:3478" }];
	expect(await staticIceServers(servers)({ auth })).toEqual({ iceServers: servers });
});
