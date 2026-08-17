import { describe, expect, test } from "bun:test";
import { ClientStore } from "../../src/client/store.ts";
import { SyncClient } from "../../src/client/sync-client.ts";
import type { ClientMessage, ServerMessage, ClientTransport } from "../../src/core/types.ts";

describe("Soft delete auto-filtering", () => {
	test("getRows excludes rows with deletedAt by default", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "active", deletedAt: null }, {}, null);
		store.setRow("posts", "r2", { title: "deleted", deletedAt: "2024-01-01" }, {}, null);
		store.setRow("posts", "r3", { title: "also active" }, {}, null);

		const rows = store.getRows("posts");
		expect(rows.length).toBe(2);
		expect(rows.map((r) => r.data!.title).sort()).toEqual(["active", "also active"]);
	});

	test("getRows with includeDeleted returns all rows", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "active", deletedAt: null }, {}, null);
		store.setRow("posts", "r2", { title: "deleted", deletedAt: "2024-01-01" }, {}, null);

		const rows = store.getRows("posts", true);
		expect(rows.length).toBe(2);
	});

	test("rows without deletedAt column are included", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "no deletedAt field" }, {}, null);

		const rows = store.getRows("posts");
		expect(rows.length).toBe(1);
	});

	test("deletedAt: null is treated as not deleted", () => {
		const store = new ClientStore();
		store.setRow("posts", "r1", { title: "active", deletedAt: null }, {}, null);

		const rows = store.getRows("posts");
		expect(rows.length).toBe(1);
	});

	test("SyncClient.getRows auto-filters deleted rows", () => {
		const transport: ClientTransport = {
			async send() {},
			subscribe() {},
			async close() {},
		};
		const client = new SyncClient({
			clientId: "test",
			transport,
			token: "t",
		});

		// Simulate snapshot with soft-deleted rows
		client.getStore().setRow("posts", "r1", { title: "active", deletedAt: null }, {}, null);
		client
			.getStore()
			.setRow("posts", "r2", { title: "deleted", deletedAt: "2024-01-01" }, {}, null);

		expect(client.getRows("posts").length).toBe(1);
		expect(client.getRows("posts")[0]!.title).toBe("active");

		expect(client.getRows("posts", { includeDeleted: true }).length).toBe(2);
	});
});
