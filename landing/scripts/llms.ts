import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const ORIGIN = "https://reflectdb.dev";
const REPO = "https://github.com/TimMikeladze/reflectdb/blob/main/";
const DOCUMENTS = [
	["README.md", "docs/README.md"],
	["docs/object-storage.md", "docs/object-storage.md"],
	["docs/webrtc.md", "docs/webrtc.md"],
	["skills/reflectdb/SKILL.md", "skills/reflectdb/SKILL.md"],
	["skills/reflectdb/references/integration.md", "skills/reflectdb/references/integration.md"],
] as const;

function markdown(source: string): string {
	const content = readFileSync(join(ROOT, source), "utf8");
	return content.replace(/\]\(([^\s)]+)\)/g, (match, href: string) => {
		if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return match;
		const target = new URL(href, `${REPO}${source}`);
		const sourcePath = decodeURIComponent(
			target.pathname.replace("/TimMikeladze/reflectdb/blob/main/", ""),
		);
		const document = DOCUMENTS.find(([path]) => path === sourcePath);
		const url = document ? `${ORIGIN}/${document[1]}${target.search}${target.hash}` : target.href;
		return `](${url})`;
	});
}

export function generateLlmDocs(outputDir = join(ROOT, "landing/public")): void {
	const write = (path: string, content: string): void => {
		const destination = join(outputDir, path);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, content);
	};
	const index = readFileSync(join(ROOT, "llms.txt"), "utf8");
	const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
		version: string;
	};
	write("llms.txt", index);
	write("llm.txt", index);
	write("index.md", index);
	const sections = [`# ReflectDB documentation\n\nPackage version: ${version}.\n`];
	for (const [source, destination] of DOCUMENTS) {
		const content = markdown(source);
		write(destination, content);
		sections.push(`Source: ${ORIGIN}/${destination}\n\n${content}`);
	}
	write("llms-full.txt", sections.join("\n\n---\n\n"));
	console.log(`Generated LLM documentation in ${relative(ROOT, outputDir).split(sep).join("/")}`);
}

if (import.meta.main) generateLlmDocs();
