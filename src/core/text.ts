/**
 * Three-way text merge for columns declared with `conflict: { policy: "merge", text: [...] }`.
 *
 * The server is the only place a merge becomes final. Clients run the same merge
 * to keep what they typed while a write was in flight, so nothing here needs to
 * be commutative: the server's order wins and everyone converges on its text.
 */

/** Replace `[start, end)` of the old text with the string. */
export type TextHunk = [start: number, end: number, insert: string];

/** Past this many edits a character diff stops being useful: the middle becomes one hunk. */
const MAX_EDITS = 2000;

/** Character diff (Myers), trimmed at both ends because most edits touch one spot. */
export function diffText(a: string, b: string): TextHunk[] {
	if (a === b) return [];
	let head = 0;
	const max = Math.min(a.length, b.length);
	while (head < max && a.charCodeAt(head) === b.charCodeAt(head)) head++;
	let tail = 0;
	while (
		tail < max - head &&
		a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)
	)
		tail++;
	const n = a.length - head - tail;
	const m = b.length - head - tail;
	if (n === 0 || m === 0) return [[head, head + n, b.slice(head, head + m)]];

	const whole: TextHunk[] = [[head, head + n, b.slice(head, head + m)]];
	const limit = Math.min(n + m, MAX_EDITS);
	const offset = limit + 1;
	let v = new Int32Array(2 * limit + 3);
	const trace: Int32Array[] = [];
	let found = -1;
	for (let d = 0; d <= limit && found < 0; d++) {
		trace.push(v.slice());
		const next = v.slice();
		for (let k = -d; k <= d; k += 2) {
			const down =
				k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number));
			let x = down ? (v[offset + k + 1] as number) : (v[offset + k - 1] as number) + 1;
			let y = x - k;
			while (x < n && y < m && a.charCodeAt(head + x) === b.charCodeAt(head + y)) {
				x++;
				y++;
			}
			next[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
		v = next;
	}
	if (found < 0) return whole;

	// Walk back to recover the path, then fold runs of edits into hunks.
	const edits: { type: "del" | "ins"; x: number; y: number }[] = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const prev = trace[d] as Int32Array;
		const k = x - y;
		const down =
			k === -d || (k !== d && (prev[offset + k - 1] as number) < (prev[offset + k + 1] as number));
		const prevK = down ? k + 1 : k - 1;
		const prevX = prev[offset + prevK] as number;
		const prevY = prevX - prevK;
		edits.push(down ? { type: "ins", x: prevX, y: prevY } : { type: "del", x: prevX, y: prevY });
		x = prevX;
		y = prevY;
	}
	edits.reverse();

	const hunks: TextHunk[] = [];
	let cur: TextHunk | null = null;
	for (const e of edits) {
		const at = head + e.x;
		if (!cur || cur[1] !== at) {
			if (cur) hunks.push(cur);
			cur = [at, at, ""];
		}
		if (e.type === "del") cur[1] = at + 1;
		else cur[2] += b.charAt(head + e.y);
	}
	if (cur) hunks.push(cur);
	return hunks;
}

export function applyHunks(text: string, hunks: readonly TextHunk[]): string {
	let out = "";
	let pos = 0;
	for (const [start, end, insert] of hunks) {
		out += text.slice(pos, start) + insert;
		pos = end;
	}
	return out + text.slice(pos);
}

/**
 * Apply both sides' changes to `base`. Changes that don't overlap both land, an
 * identical change lands once, and overlapping changes delete the union of what
 * they deleted and keep both inserts, `ours` first. Nothing either side typed is lost.
 */
export function merge3(base: string, ours: string, theirs: string): string {
	if (ours === theirs || theirs === base) return ours;
	if (ours === base) return theirs;
	const a = diffText(base, ours);
	const b = diffText(base, theirs);
	let i = 0;
	let j = 0;
	let pos = 0;
	let out = "";
	while (i < a.length || j < b.length) {
		const x = a[i];
		const y = b[j];
		if (x && y && (x[0] === y[0] || (x[0] < y[1] && y[0] < x[1]))) {
			const start = Math.min(x[0], y[0]);
			out += base.slice(pos, start) + x[2] + (x[2] === y[2] ? "" : y[2]);
			pos = Math.max(x[1], y[1]);
			i++;
			j++;
			continue;
		}
		const first = !y || (x && x[0] <= y[0]) ? (x as TextHunk) : y;
		if (first === x) i++;
		else j++;
		out += base.slice(pos, first[0]) + first[2];
		pos = first[1];
	}
	return out + base.slice(pos);
}

/**
 * Where an offset in `prev` lands in `next`. Text inserted exactly at the offset
 * stays after it, so a remote insert at your caret doesn't push your caret past it.
 */
export function mapOffset(prev: string, next: string, offset: number): number {
	let delta = 0;
	for (const [start, end, insert] of diffText(prev, next)) {
		if (end < offset || (end === offset && start < offset)) {
			delta += insert.length - (end - start);
		} else if (start < offset) {
			return start + delta + insert.length;
		} else break;
	}
	return offset + delta;
}

/** FNV-1a. Checks a patch landed on the text it was made for; not a security boundary. */
export function hashText(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Payload key a text binding writes under. Never reaches a row. */
export const TEXT_EDIT_KEY = "$text";

/**
 * Column holding `{ [writer]: n }`: the latest write of each writer the row
 * includes. It travels with the text in the same delta, which is how a writer
 * knows the text it's looking at already contains its own write. `mutate` must
 * persist it like any other column, and `query` must return it.
 */
export const TEXT_SEEN_COLUMN = "_seen";

/** Writers a row remembers. The oldest is dropped past this. */
export const TEXT_SEEN_LIMIT = 64;

export type TextEdit = {
	who: string;
	n: number;
	edits?: Record<string, { value: string; back: TextHunk[] }>;
	/** Set `softDelete` if the row's text still hashes to this. */
	remove?: { column: string; baseHash: number };
};
