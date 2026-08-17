import { describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/server/session.ts";

describe("SessionManager", () => {
	test("connect creates a session", () => {
		const mgr = new SessionManager();
		const session = mgr.connect("client1");
		expect(session.clientId).toBe("client1");
		expect(session.auth).toBeNull();
		expect(session.subscriptions.size).toBe(0);
		expect(session.watermark).toBeNull();
		expect(mgr.size()).toBe(1);
	});

	test("disconnect removes a session", () => {
		const mgr = new SessionManager();
		mgr.connect("client1");
		mgr.disconnect("client1");
		expect(mgr.get("client1")).toBeUndefined();
		expect(mgr.size()).toBe(0);
	});

	test("setAuth updates session auth", () => {
		const mgr = new SessionManager();
		mgr.connect("client1");
		mgr.setAuth("client1", { userId: "user1" });
		expect(mgr.get("client1")!.auth).toEqual({ userId: "user1" });
	});

	test("subscribe adds a query subscription", () => {
		const mgr = new SessionManager();
		mgr.connect("client1");
		mgr.subscribe("client1", "posts", {}, { conflict: "lww" });
		const session = mgr.get("client1")!;
		expect(session.subscriptions.has("posts")).toBe(true);
		expect(session.subscriptions.get("posts")!.queryName).toBe("posts");
	});

	test("unsubscribe removes a query subscription", () => {
		const mgr = new SessionManager();
		mgr.connect("client1");
		mgr.subscribe("client1", "posts", {}, {});
		mgr.unsubscribe("client1", "posts");
		expect(mgr.get("client1")!.subscriptions.has("posts")).toBe(false);
	});

	test("updateWatermark advances only forward", () => {
		const mgr = new SessionManager();
		mgr.connect("client1");
		mgr.updateWatermark("client1", "0000000000000002000.0000.server:1");
		mgr.updateWatermark("client1", "0000000000000001000.0000.server:1");
		expect(mgr.get("client1")!.watermark).toBe("0000000000000002000.0000.server:1");
	});

	test("getSubscribersForQuery returns matching sessions", () => {
		const mgr = new SessionManager();
		mgr.connect("client1");
		mgr.connect("client2");
		mgr.connect("client3");
		mgr.subscribe("client1", "posts", {}, {});
		mgr.subscribe("client2", "posts", {}, {});
		mgr.subscribe("client3", "comments", {}, {});

		const subs = mgr.getSubscribersForQuery("posts");
		expect(subs.length).toBe(2);
		expect(subs.map((s) => s.clientId).sort()).toEqual(["client1", "client2"]);
	});

	test("getAll returns all sessions", () => {
		const mgr = new SessionManager();
		mgr.connect("c1");
		mgr.connect("c2");
		expect(mgr.getAll().length).toBe(2);
	});

	test("reverse index is updated on subscribe and unsubscribe", () => {
		const mgr = new SessionManager();
		mgr.connect("c1");
		mgr.connect("c2");
		mgr.subscribe("c1", "posts", {}, {});
		mgr.subscribe("c2", "posts", {}, {});

		expect(mgr.getSubscribersForQuery("posts").length).toBe(2);

		mgr.unsubscribe("c1", "posts");
		expect(mgr.getSubscribersForQuery("posts").length).toBe(1);
		expect(mgr.getSubscribersForQuery("posts")[0]!.clientId).toBe("c2");
	});

	test("reverse index is cleaned up on disconnect", () => {
		const mgr = new SessionManager();
		mgr.connect("c1");
		mgr.connect("c2");
		mgr.subscribe("c1", "posts", {}, {});
		mgr.subscribe("c2", "posts", {}, {});

		mgr.disconnect("c1");
		const subs = mgr.getSubscribersForQuery("posts");
		expect(subs.length).toBe(1);
		expect(subs[0]!.clientId).toBe("c2");
	});

	test("getSubscribersForQuery returns empty for unknown query", () => {
		const mgr = new SessionManager();
		mgr.connect("c1");
		expect(mgr.getSubscribersForQuery("nonexistent").length).toBe(0);
	});
});
