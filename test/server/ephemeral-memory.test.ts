import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { EphemeralManager } from "../../src/server/ephemeral-manager.ts";

describe("EphemeralManager size cap", () => {
	test("rejects new entries at capacity", () => {
		const manager = new EphemeralManager(3);

		expect(manager.set("room1", "cursor", "c1", "u1", { x: 1 })).toBe(true);
		expect(manager.set("room1", "cursor", "c2", "u2", { x: 2 })).toBe(true);
		expect(manager.set("room1", "cursor", "c3", "u3", { x: 3 })).toBe(true);

		// At capacity — new entry rejected
		expect(manager.set("room1", "cursor", "c4", "u4", { x: 4 })).toBe(false);
		expect(manager.size).toBe(3);
	});

	test("allows updates when at capacity", () => {
		const manager = new EphemeralManager(2);

		manager.set("room1", "cursor", "c1", "u1", { x: 1 });
		manager.set("room1", "cursor", "c2", "u2", { x: 2 });

		// Update existing entry — should succeed
		expect(manager.set("room1", "cursor", "c1", "u1", { x: 10 })).toBe(true);
		expect(manager.size).toBe(2);

		const states = manager.get("room1", "cursor");
		expect(states.u1.data.x).toBe(10);
	});

	test("accepts new entries after removal frees capacity", () => {
		const manager = new EphemeralManager(2);

		manager.set("room1", "cursor", "c1", "u1", { x: 1 });
		manager.set("room1", "cursor", "c2", "u2", { x: 2 });

		// Full
		expect(manager.set("room1", "cursor", "c3", "u3", { x: 3 })).toBe(false);

		// Remove one
		manager.remove("room1", "cursor", "u1");
		expect(manager.size).toBe(1);

		// Now there's space
		expect(manager.set("room1", "cursor", "c3", "u3", { x: 3 })).toBe(true);
		expect(manager.size).toBe(2);
	});

	test("removeClient decrements count correctly", () => {
		const manager = new EphemeralManager(10);

		manager.set("room1", "cursor", "c1", "u1", { x: 1 });
		manager.set("room1", "typing", "c1", "u1", { text: "hi" });
		manager.set("room1", "cursor", "c2", "u2", { x: 2 });

		expect(manager.size).toBe(3);

		manager.removeClient("c1");
		expect(manager.size).toBe(1);
	});

	test("destroy resets count", () => {
		const manager = new EphemeralManager(10);
		manager.set("room1", "cursor", "c1", "u1", { x: 1 });
		manager.set("room1", "cursor", "c2", "u2", { x: 2 });

		manager.destroy();
		expect(manager.size).toBe(0);
	});

	test("cleanupExpired decrements count", () => {
		const manager = new EphemeralManager(10);

		// Entry with very short TTL
		manager.set("room1", "cursor", "c1", "u1", { x: 1 }, 1);
		expect(manager.size).toBe(1);

		// Wait for TTL to expire
		const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
		return wait(10).then(() => {
			manager.cleanupExpired();
			expect(manager.size).toBe(0);
		});
	});
});

describe("EphemeralManager", () => {
	let manager: EphemeralManager;

	beforeEach(() => {
		manager = new EphemeralManager();
	});

	afterEach(() => {
		manager.destroy();
	});

	it("stores and retrieves ephemeral state", () => {
		manager.set("room1", "cursor", "client1", "user1", { x: 10, y: 20 });

		const state = manager.get("room1", "cursor");
		expect(Object.keys(state)).toEqual(["user1"]);
		expect(state.user1!.data).toEqual({ x: 10, y: 20 });
	});

	it("returns empty object for non-existent keys", () => {
		const state = manager.get("room1", "nonexistent");
		expect(state).toEqual({});
	});

	it("removes specific user state", () => {
		manager.set("room1", "cursor", "client1", "user1", { x: 10, y: 20 });
		manager.set("room1", "cursor", "client2", "user2", { x: 30, y: 40 });

		manager.remove("room1", "cursor", "user1");

		const state = manager.get("room1", "cursor");
		expect(Object.keys(state)).toEqual(["user2"]);
	});

	it("removes all state for a client", () => {
		manager.set("room1", "cursor", "client1", "user1", { x: 10, y: 20 });
		manager.set("room1", "typing", "client1", "user1", { active: true });
		manager.set("room1", "cursor", "client2", "user2", { x: 30, y: 40 });

		manager.removeClient("client1");

		const cursor = manager.get("room1", "cursor");
		const typing = manager.get("room1", "typing");

		expect(Object.keys(cursor)).toEqual(["user2"]);
		expect(typing).toEqual({});
	});

	it("cleans up expired entries", () => {
		const now = Date.now();

		manager.set("room1", "cursor", "client1", "user1", { x: 10 }, 1000);
		manager.set("room1", "cursor", "client2", "user2", { x: 20 }, 5000);

		// Mock Date.now() for cleanup
		const originalNow = Date.now;
		Date.now = () => now + 3000; // 3 seconds later

		manager.cleanupExpired();

		Date.now = originalNow;

		const state = manager.get("room1", "cursor");
		expect(Object.keys(state)).toEqual(["user2"]);
	});

	it("supports multiple rooms", () => {
		manager.set("room1", "cursor", "client1", "user1", { x: 10 });
		manager.set("room2", "cursor", "client2", "user2", { x: 20 });

		const room1 = manager.get("room1", "cursor");
		const room2 = manager.get("room2", "cursor");

		expect(Object.keys(room1)).toEqual(["user1"]);
		expect(Object.keys(room2)).toEqual(["user2"]);
	});

	it("cleanupExpired drops stale clientIndex entries (no identity leak)", () => {
		const now = Date.now();
		manager.set("room1", "cursor", "client1", "user1", { x: 10 }, 1000);
		manager.set("room1", "cursor", "client1", "user2", { x: 20 }, 1000);

		const originalNow = Date.now;
		Date.now = () => now + 3000;
		manager.cleanupExpired();
		Date.now = originalNow;

		// Both expired and removed from store
		expect(manager.get("room1", "cursor")).toEqual({});
		// And clientIndex must not retain stale entries
		// (verify by re-setting and checking removeClient still wipes cleanly)
		manager.set("room1", "cursor", "client1", "user1", { x: 99 });
		manager.removeClient("client1");
		expect(manager.get("room1", "cursor")).toEqual({});
		expect(manager.size).toBe(0);
	});

	it("removeClient after many sets does not leave dangling state", () => {
		// Drive many ops to surface any object-identity bug
		for (let i = 0; i < 50; i++) {
			manager.set("room1", `key${i}`, "client1", "user1", { v: i });
		}
		expect(manager.size).toBe(50);
		manager.removeClient("client1");
		expect(manager.size).toBe(0);
		for (let i = 0; i < 50; i++) {
			expect(manager.get("room1", `key${i}`)).toEqual({});
		}
	});

	it("clears all state on destroy", () => {
		manager.set("room1", "cursor", "client1", "user1", { x: 10 });
		manager.set("room1", "typing", "client1", "user1", { active: true });

		manager.destroy();

		const cursor = manager.get("room1", "cursor");
		const typing = manager.get("room1", "typing");

		expect(cursor).toEqual({});
		expect(typing).toEqual({});
	});

});
