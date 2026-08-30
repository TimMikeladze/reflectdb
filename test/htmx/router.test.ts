import { describe, expect, test } from "bun:test";
import { collectPayload, parseReflectAction, resolveOperation } from "../../src/htmx/router.ts";

describe("parseReflectAction", () => {
	test("collection action", () => {
		const parsed = parseReflectAction("reflect:todos");
		expect(parsed?.table).toBe("todos");
		expect(parsed?.rowId).toBeUndefined();
	});

	test("row action", () => {
		const parsed = parseReflectAction("reflect:todos/abc-1");
		expect(parsed?.table).toBe("todos");
		expect(parsed?.rowId).toBe("abc-1");
	});

	test("query params are exposed to the view", () => {
		const parsed = parseReflectAction("reflect:todos?done=false&sort=created");
		expect(parsed?.table).toBe("todos");
		expect(parsed?.params.get("done")).toBe("false");
		expect(parsed?.params.get("sort")).toBe("created");
	});

	// htmx rewrites GET/DELETE actions through `new URL(action, baseURI)` before
	// the fetch runs; `reflect:` is a non-special scheme so href round-trips.
	test("survives the URL round-trip htmx performs on GET", () => {
		const url = new URL("reflect:todos", "https://app.example/x/");
		url.searchParams.append("boardId", "1");
		const parsed = parseReflectAction(url.href);
		expect(parsed?.table).toBe("todos");
		expect(parsed?.params.get("boardId")).toBe("1");
	});

	test("percent-encoded segments are decoded", () => {
		expect(parseReflectAction("reflect:todos/a%2Fb")?.rowId).toBe("a/b");
	});

	test("rejects non-reflect and malformed actions", () => {
		expect(parseReflectAction("/api/todos")).toBeNull();
		expect(parseReflectAction("https://example.com/todos")).toBeNull();
		expect(parseReflectAction("reflect:")).toBeNull();
		expect(parseReflectAction("reflect:todos/abc/extra")).toBeNull();
		expect(parseReflectAction("reflect:todos/%")).toBeNull();
	});

	test("a trailing slash still reads the collection", () => {
		const parsed = parseReflectAction("reflect:todos/");
		expect(parsed?.table).toBe("todos");
		expect(parsed?.rowId).toBeUndefined();
	});
});

describe("resolveOperation", () => {
	test("GET collection and GET row", () => {
		expect(resolveOperation("reflect:todos", "GET")).toMatchObject({
			kind: "read",
			table: "todos",
		});
		expect(resolveOperation("reflect:todos/a", "GET")).toMatchObject({
			kind: "read",
			table: "todos",
			rowId: "a",
		});
	});

	test("POST inserts with a generated row id", () => {
		const op = resolveOperation(
			"reflect:todos",
			"POST",
			new URLSearchParams({ text: "buy milk" }),
			{ generateRowId: () => "generated-1" },
		);
		expect(op).toEqual({
			kind: "insert",
			table: "todos",
			rowId: "generated-1",
			payload: { text: "buy milk" },
		});
	});

	test("POST prefers an id supplied in the body, and consumes it", () => {
		const op = resolveOperation(
			"reflect:todos",
			"POST",
			new URLSearchParams({ id: "chosen", text: "x" }),
			{ generateRowId: () => "generated-1" },
		);
		// `id` named the row; it is not also a column. The store materializes the
		// primary key from the row id, so keeping it would duplicate the default
		// `id` pk and invent a stray column on a table whose pk is named
		// something else.
		expect(op).toEqual({
			kind: "insert",
			table: "todos",
			rowId: "chosen",
			payload: { text: "x" },
		});
	});

	test("PUT and PATCH update the addressed row", () => {
		for (const verb of ["PUT", "PATCH"]) {
			expect(resolveOperation("reflect:todos/a", verb, new URLSearchParams({ text: "y" }))).toEqual(
				{ kind: "update", table: "todos", rowId: "a", payload: { text: "y" } },
			);
		}
	});

	test("DELETE removes the addressed row", () => {
		expect(resolveOperation("reflect:todos/a", "DELETE")).toEqual({
			kind: "remove",
			table: "todos",
			rowId: "a",
		});
	});

	test("methods are case-insensitive", () => {
		expect(resolveOperation("reflect:todos/a", "delete")).toMatchObject({ kind: "remove" });
	});

	test("writes without a row id are a 400", () => {
		for (const verb of ["PUT", "PATCH", "DELETE"]) {
			expect(resolveOperation("reflect:todos", verb)).toMatchObject({
				kind: "error",
				status: 400,
			});
		}
	});

	test("POST to a row url is a 400", () => {
		expect(resolveOperation("reflect:todos/a", "POST")).toMatchObject({
			kind: "error",
			status: 400,
		});
	});

	test("unsupported methods are a 405", () => {
		expect(resolveOperation("reflect:todos", "HEAD")).toMatchObject({
			kind: "error",
			status: 405,
		});
	});

	test("non-reflect actions are not ours", () => {
		expect(resolveOperation("/api/todos", "GET")).toBeNull();
	});
});

describe("collectPayload", () => {
	test("repeated keys collapse into an array", () => {
		const body = new URLSearchParams();
		body.append("tag", "a");
		body.append("tag", "b");
		body.append("text", "x");
		expect(collectPayload(body)).toEqual({ tag: ["a", "b"], text: "x" });
	});

	test("non-string entries are dropped — a File cannot cross the op log", () => {
		const body = new FormData();
		body.append("text", "x");
		body.append("upload", new File(["data"], "note.txt"));
		expect(collectPayload(body)).toEqual({ text: "x" });
	});

	test("an absent body is an empty payload", () => {
		expect(collectPayload(null)).toEqual({});
	});
});
