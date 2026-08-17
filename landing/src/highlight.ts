/**
 * Minimal TS/TSX highlighter.
 *
 * Snippets on this page are authored as plain source, so they can be copied,
 * diffed against the real API, and pasted into an editor without stripping
 * markup. This turns them into spans at render time.
 */

const KEYWORDS = new Set([
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"default",
	"delete",
	"do",
	"else",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"from",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"interface",
	"let",
	"new",
	"null",
	"of",
	"return",
	"satisfies",
	"switch",
	"throw",
	"true",
	"try",
	"type",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"yield",
]);

// Order matters: comments, then strings, then numbers, then words.
const TOKEN =
	/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)/g;

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function span(cls: string, text: string): string {
	return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

export function highlight(src: string): string {
	let out = "";
	let last = 0;

	for (const m of src.matchAll(TOKEN)) {
		const start = m.index ?? 0;
		out += escapeHtml(src.slice(last, start));
		last = start + m[0].length;

		if (m[1]) {
			out += span("c", m[1]);
		} else if (m[2]) {
			out += span("s", m[2]);
		} else if (m[3]) {
			out += span("n", m[3]);
		} else {
			const word = m[4]!;
			if (KEYWORDS.has(word)) {
				out += span("k", word);
			} else if (/^\s*\(/.test(src.slice(last))) {
				// Identifier immediately followed by `(` — a call or declaration.
				out += span("t", word);
			} else if (/^[A-Z]/.test(word)) {
				out += span("y", word);
			} else {
				out += escapeHtml(word);
			}
		}
	}

	out += escapeHtml(src.slice(last));
	return out;
}
