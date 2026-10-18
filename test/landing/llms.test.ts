import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateLlmDocs } from "../../landing/scripts/llms.ts";

const ROOT = resolve(import.meta.dir, "../..");

test("LLM docs include current sources and their linked documents can be served", () => {
	const output = mkdtempSync(join(tmpdir(), "reflectdb-llms-"));
	try {
		generateLlmDocs(output);
		const read = (path: string): string => readFileSync(join(output, path), "utf8");
		const index = read("llms.txt");
		expect(index).toBe(readFileSync(join(ROOT, "llms.txt"), "utf8"));
		expect(read("llm.txt")).toBe(index);
		const full = read("llms-full.txt");
		const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		expect(full).toContain(`Package version: ${version}`);
		for (const path of [
			"docs/README.md",
			"docs/object-storage.md",
			"docs/webrtc.md",
			"skills/reflectdb/SKILL.md",
			"skills/reflectdb/references/integration.md",
		]) {
			expect(full).toContain(read(path));
		}
		const queue = ["llms.txt", "index.md", "llms-full.txt"];
		const visited = new Set<string>();
		while (queue.length) {
			const path = queue.pop()!;
			if (visited.has(path)) continue;
			visited.add(path);
			for (const match of read(path).matchAll(/\]\(([^\s)]+)\)/g)) {
				expect(match[1]).toMatch(/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i);
			}
			for (const match of read(path).matchAll(/\]\((https:\/\/reflectdb\.dev\/[^\s)]*)\)/g)) {
				const url = new URL(match[1]!);
				if (url.pathname === "/") continue;
				queue.push(decodeURIComponent(url.pathname.slice(1)));
			}
		}
		expect(visited.has("skills/reflectdb/references/integration.md")).toBe(true);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});
