/**
 * Inline SVG diagrams.
 *
 * Everything is theme-driven: strokes and fills reference the same CSS custom
 * properties as the rest of the page, so the diagrams stay in the palette and
 * scale with the viewport (viewBox + width:100%).
 */

import { escapeHtml } from "./highlight.ts";

type Tone = "fg" | "g" | "b" | "o" | "m";

let diagramCount = 0;

function frame(w: number, h: number, body: (id: string) => string): string {
	const id = `dg${++diagramCount}`;
	const marker = (suffix: string, cls: string) =>
		`<marker id="${id}-${suffix}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="${cls}"/></marker>`;
	return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img"><defs>${marker(
		"fg",
		"mk-fg",
	)}${marker("g", "mk-g")}${marker("b", "mk-b")}${marker("o", "mk-o")}${marker(
		"m",
		"mk-m",
	)}</defs>${body(id)}</svg>`;
}

const LINE_H = 15;

interface NodeOpts {
	tone?: Tone;
	dashed?: boolean;
	/** Left-align the text block instead of centering it. */
	left?: boolean;
}

/** Rounded box with a bold first line and muted following lines. */
function node(
	x: number,
	y: number,
	w: number,
	h: number,
	rows: string[],
	opts: NodeOpts = {},
): string {
	const tone = opts.tone ?? "fg";
	const dash = opts.dashed ? ` stroke-dasharray="3 3"` : "";
	const total = rows.length * LINE_H;
	const top = y + (h - total) / 2 + 11;
	const tx = opts.left ? x + 12 : x + w / 2;
	const anchor = opts.left ? "start" : "middle";
	const text = rows
		.map(
			(row, i) =>
				`<text x="${tx}" y="${top + i * LINE_H}" text-anchor="${anchor}" class="${
					i === 0 ? `t1 tone-${tone}` : "t2"
				}">${escapeHtml(row)}</text>`,
		)
		.join("");
	return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" class="nb nb-${tone}"${dash}/>${text}`;
}

/** Polyline arrow through the given points. */
function arrow(
	points: Array<[number, number]>,
	id: string,
	tone: Tone = "fg",
	dashed = false,
): string {
	const d = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
	const dash = dashed ? ` stroke-dasharray="4 3"` : "";
	return `<path d="${d}" class="ln ln-${tone}" fill="none" marker-end="url(#${id}-${tone})"${dash}/>`;
}

function line(points: Array<[number, number]>, tone: Tone = "m", dashed = false): string {
	const d = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
	const dash = dashed ? ` stroke-dasharray="4 3"` : "";
	return `<path d="${d}" class="ln ln-${tone}" fill="none"${dash}/>`;
}

function label(
	x: number,
	y: number,
	text: string,
	anchor: "start" | "middle" | "end" = "middle",
	cls = "t2",
): string {
	return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}">${escapeHtml(text)}</text>`;
}

/** Filled event marker, for timelines where a box would be too heavy. */
function dot(x: number, y: number, tone: Tone = "fg", r = 5): string {
	return `<circle cx="${x}" cy="${y}" r="${r}" class="pt pt-${tone}"/>`;
}

/** Thicker underline, for calling out one span of a longer string. */
function bar(x1: number, x2: number, y: number, tone: Tone): string {
	return `<path d="M${x1},${y} L${x2},${y}" class="ln ln-${tone} bar" fill="none"/>`;
}

function stepNo(x: number, y: number, n: number): string {
	return `<circle cx="${x}" cy="${y}" r="9" class="num"/><text x="${x}" y="${
		y + 3.5
	}" text-anchor="middle" class="numt">${n}</text>`;
}

// ── 0a. Latency — where the round trip actually sits ────────────────────

export const latency = frame(880, 316, (id) => {
	const LANE_A = 96;
	const LANE_S = 176;
	const LANE_B = 256;
	const T0 = 262;
	const T1 = 668;

	return [
		label(24, LANE_A + 4, "YOUR TAB", "start", "hd"),
		label(24, LANE_S + 4, "SERVER", "start", "hd"),
		label(24, LANE_B + 4, "OTHER TAB", "start", "hd"),
		line([
			[150, LANE_A],
			[T1 + 8, LANE_A],
		]),
		line([
			[150, LANE_S],
			[610, LANE_S],
		]),
		line([
			[150, LANE_B],
			[T1 + 8, LANE_B],
		]),
		line(
			[
				[T0, 54],
				[T0, 288],
			],
			"m",
			true,
		),

		dot(T0, LANE_A, "g"),
		label(T0, 62, "you click", "middle", "t1"),
		label(T0, 78, "the row has already changed", "middle", "t2"),

		arrow(
			[
				[272, 104],
				[396, 150],
			],
			id,
			"g",
		),
		label(290, 142, "op + hlc", "start"),

		node(400, 152, 200, 48, ["pipeline · mutate · commit"], { tone: "b" }),

		arrow(
			[
				[604, 168],
				[634, 168],
				[634, 104],
				[660, 104],
			],
			id,
			"b",
		),
		label(640, 140, "ack", "start"),
		arrow(
			[
				[604, 184],
				[634, 184],
				[634, 248],
				[660, 248],
			],
			id,
			"b",
		),
		label(640, 216, "delta", "start"),

		dot(T1, LANE_A, "b"),
		label(686, 92, "confirmed — nothing repaints", "start", "t2"),
		dot(T1, LANE_B, "g"),
		label(686, 252, "the row appears here too", "start", "t1"),

		label(T0, 304, "0 ms"),
		label(T1, 304, "one round trip later"),
	].join("");
});

// ── 0b. The clock — ordering as a string compare ────────────────────────

export const clock = frame(880, 244, () => {
	const CH = 13.2;
	const X0 = 209;
	const big = (x: number, chars: number, text: string, tone: Tone) =>
		`<text x="${x}" y="86" textLength="${(chars * CH).toFixed(1)}" lengthAdjust="spacing" class="big tone-${tone}">${escapeHtml(
			text,
		)}</text>`;

	const xMs = X0;
	const xDot1 = xMs + 19 * CH;
	const xCtr = xDot1 + CH;
	const xDot2 = xCtr + 4 * CH;
	const xNid = xDot2 + CH;
	const xEnd = xNid + 10 * CH;

	return [
		label(440, 44, "ONE WRITE'S STAMP", "middle", "hd"),
		big(xMs, 19, "0000001711234567890", "o"),
		big(xDot1, 1, ".", "m"),
		big(xCtr, 4, "0003", "g"),
		big(xDot2, 1, ".", "m"),
		big(xNid, 10, "client-a1f", "b"),

		bar(xMs, xDot1, 104, "o"),
		bar(xCtr, xDot2, 104, "g"),
		bar(xNid, xEnd, 104, "b"),

		label((xMs + xDot1) / 2, 126, "wall-clock ms", "middle", "t1"),
		label((xMs + xDot1) / 2, 142, "padded to 19 digits", "middle", "t2"),
		label((xCtr + xDot2) / 2, 126, "counter", "middle", "t1"),
		label((xCtr + xDot2) / 2, 142, "same-ms ties", "middle", "t2"),
		label((xNid + xEnd) / 2, 126, "who wrote it", "middle", "t1"),
		label((xNid + xEnd) / 2, 142, "final tiebreak", "middle", "t2"),

		label(
			440,
			190,
			"0000001711234567890.0003.client-a1f  <  0000001711234567890.0004.client-b7c",
			"middle",
			"t2",
		),
		label(440, 218, "causal order is lexicographic order — no parsing, no synchronized clocks"),
	].join("");
});

// ── 0c. Conflict policies, side by side ─────────────────────────────────

export const policies = frame(880, 280, () => {
	const W = 406;
	const H = 86;
	return [
		label(24, 34, "DECLARED PER TABLE, IN THE SCHEMA", "start", "hd"),
		node(
			24,
			52,
			W,
			H,
			["lww — whole row", "the later clock replaces the row;", "the other edit is gone"],
			{
				tone: "g",
				left: true,
			},
		),
		node(
			450,
			52,
			W,
			H,
			["merge — per column", "every column keeps its own newest", "write, so both edits land"],
			{ tone: "b", left: true },
		),
		node(
			24,
			152,
			W,
			H,
			["server — first write only", "the row is created once; every", "later write is refused"],
			{ tone: "o", left: true },
		),
		node(
			450,
			152,
			W,
			H,
			["custom — your function", "you get the op, the row and its", "clocks; you return the row"],
			{ tone: "fg", left: true },
		),
		label(440, 268, "both eager broadcast modes skip the question — writes land last-writer-wins"),
	].join("");
});

// ── 0d. Offline, and the queue that drains ──────────────────────────────

export const offlineQueue = frame(880, 306, (id) => {
	const chip = (y: number, text: string) =>
		[
			`<rect x="300" y="${y}" width="230" height="24" rx="3" class="nb nb-o"/>`,
			label(310, y + 16, text, "start", "t2"),
		].join("");

	return [
		label(24, 32, "WHILE THE SOCKET IS DOWN", "start", "hd"),
		node(
			24,
			46,
			250,
			76,
			["your tab", "insert and update keep working", "at full speed, in order"],
			{
				tone: "g",
				left: true,
			},
		),
		label(300, 42, "pending — IndexedDB", "start", "t2"),
		chip(52, "update todos/42 …0007"),
		chip(82, "insert todos/91 …0008"),
		chip(112, "delete todos/17 …0009"),
		line(
			[
				[576, 44],
				[576, 140],
			],
			"o",
			true,
		),
		label(576, 34, "no socket", "middle", "t2"),
		node(610, 62, 246, 60, ["the server", "hears nothing about any of it"], {
			tone: "b",
			left: true,
		}),

		label(24, 186, "BACK", "start", "hd"),
		node(24, 200, 250, 60, ["reconnect", "hello · sync_declare · resume"], {
			tone: "g",
			left: true,
		}),
		arrow(
			[
				[280, 230],
				[606, 230],
			],
			id,
			"g",
		),
		label(443, 218, "ops[] — everything queued, ≤ 100 per message", "middle", "t2"),
		node(610, 200, 246, 60, ["ack [opIds]", "each op id reserved exactly once"], {
			tone: "b",
			left: true,
		}),
		label(440, 294, "a resend after a dropped frame is acked, never applied a second time"),
	].join("");
});

// ── 1. Topology ─────────────────────────────────────────────────────────

export const topology = frame(880, 292, (id) => {
	const a = node(20, 44, 210, 92, ["Browser A", "optimistic store", "IndexedDB op queue"], {
		tone: "g",
	});
	const s = node(
		335,
		34,
		210,
		112,
		["reflectdb server", "pipeline · op log", "subscriber fan-out", "authoritative"],
		{ tone: "b" },
	);
	const b = node(650, 44, 210, 92, ["Browser B", "optimistic store", "IndexedDB op queue"], {
		tone: "g",
	});
	const db = node(335, 208, 210, 64, ["your database", "query() / mutate()"], { tone: "o" });

	return [
		a,
		s,
		b,
		db,
		arrow(
			[
				[232, 72],
				[333, 72],
			],
			id,
			"g",
		),
		label(282, 64, "ops"),
		arrow(
			[
				[333, 110],
				[232, 110],
			],
			id,
			"b",
		),
		label(282, 126, "deltas"),
		arrow(
			[
				[648, 72],
				[547, 72],
			],
			id,
			"g",
		),
		label(598, 64, "ops"),
		arrow(
			[
				[547, 110],
				[648, 110],
			],
			id,
			"b",
		),
		label(598, 126, "deltas"),
		arrow(
			[
				[410, 148],
				[410, 206],
			],
			id,
			"b",
		),
		arrow(
			[
				[470, 206],
				[470, 148],
			],
			id,
			"o",
		),
		label(332, 182, "write", "end"),
		label(548, 182, "read", "start"),
		label(440, 288, "every snapshot and every delta is read back out of your database", "middle"),
	].join("");
});

// ── 2. The write path ───────────────────────────────────────────────────

export const writePath = frame(880, 660, (id) => {
	const CX = 26;
	const CW = 250;
	const SX = 392;
	const SW = 400;

	const client = [
		node(CX, 66, CW, 50, ["update(id, { done: true })", "opCreator stamps an HLC"], { tone: "g" }),
		node(CX, 128, CW, 50, ["store.applyOptimistic", "UI repaints — no round trip"], { tone: "g" }),
		node(CX, 190, CW, 50, ["pending op → IndexedDB", "flushed before the send"], { tone: "g" }),
		node(CX, 252, CW, 50, ["push()", "coalesced · chunks of ≤ 100 ops"], { tone: "g" }),
		node(
			CX,
			340,
			CW,
			92,
			[
				"no socket?",
				"nothing above changes —",
				"the queue simply waits, and",
				"writes keep landing locally,",
				"in order, until it comes back",
			],
			{ tone: "o", dashed: true },
		),
		node(
			CX,
			470,
			CW,
			64,
			["ack → markSynced", "reject → revertOp restores the", "row exactly as it was pre-op"],
			{ tone: "g" },
		),
	].join("");

	const steps = [
		["reserveOps(ids)", "one CAS per op id — replays are idempotent"],
		["clock drift", "HLC more than 5 min ahead is refused"],
		["rate limit", "per user, per table — fail-open"],
		["batch cap", "MAX_BATCH_SIZE = 100 ops per message"],
		["strip readonly", "schema-declared fields are deleted"],
		["inject serverSet", "server-owned values overwrite the payload"],
		["resolveConflict(mirror row, colClocks)", "lww · merge · server · custom — or reject"],
		['authorize({ type: "write" })', "throw MutationError to reject with a reason"],
		["mutate(op, ctx, db)", "your database, your ORM, your transaction"],
		["applyOp(row, colClocks, hlc)", "mirror row + op-log entry — one commit"],
		["broadcastChanges(table)", "re-query dependents, diff, fan out"],
	];

	const server = steps
		.map((rows, i) =>
			node(SX, 66 + i * 42, SW, 34, rows, { tone: i === 10 ? "b" : "fg", left: true }),
		)
		.join("");

	const ackBox = node(SX, 66 + 11 * 42, SW, 34, ["ack [opIds] / reject { reason, serverRow }"], {
		tone: "b",
		left: true,
	});

	return [
		label(CX, 44, "CLIENT", "start", "hd"),
		label(SX, 44, "SERVER — every op, every path", "start", "hd"),
		client,
		server,
		ackBox,
		// ops hop
		arrow(
			[
				[CX + CW, 277],
				[312, 277],
				[312, 83],
				[SX - 2, 83],
			],
			id,
			"g",
		),
		label(318, 172, "ops[]", "start"),
		label(318, 188, "{ id, hlc,", "start"),
		label(318, 204, "  table,", "start"),
		label(318, 220, "  rowId,", "start"),
		label(318, 236, "  payload }", "start"),
		// ack hop
		arrow(
			[
				[SX - 2, 545],
				[352, 545],
				[352, 502],
				[CX + CW, 502],
			],
			id,
			"b",
		),
		// broadcast tail — leaves broadcastChanges, not the ack
		arrow(
			[
				[SX + SW, 503],
				[834, 503],
				[834, 600],
				[794, 600],
			],
			id,
			"b",
		),
		node(
			392,
			578,
			400,
			44,
			["delta → every other subscriber", "insert / update (changed columns only) / delete"],
			{ tone: "b", left: true },
		),
		stepNo(CX + CW + 18, 277, 1),
		stepNo(368, 528, 2),
		label(
			440,
			650,
			"the writer never receives its own delta — it already applied it optimistically",
		),
	].join("");
});

// ── 3. Broadcast fan-out ────────────────────────────────────────────────

export const fanout = frame(880, 420, (id) => {
	const W = 700;
	const X = 90;
	const rows: Array<[string, string]> = [
		["a write lands on table todos", '…or server.notifyChange("todos") from your own code'],
		["dependency index → affected queries", "every query whose tables[] contains todos"],
		["group the subscribers", "key = groupBy(ctx) ?? (auth, params, roomKey)"],
		["run the query ONCE per group", "maxBroadcastConcurrency groups in flight at a time"],
		["diff per client against its result cache", "inserted / updated columns / deleted rowIds"],
		["send, then commit the cache", "a failed send leaves the cache stale on purpose"],
	];

	const boxes = rows
		.map(([a, b], i) =>
			[
				node(X, 40 + i * 62, W, 46, [a, b], { tone: i === 3 ? "b" : "fg", left: true }),
				stepNo(X - 22, 63 + i * 62, i + 1),
				i < rows.length - 1
					? arrow(
							[
								[X + W / 2, 86 + i * 62],
								[X + W / 2, 100 + i * 62],
							],
							id,
							"m",
						)
					: "",
			].join(""),
		)
		.join("");

	return [
		boxes,
		label(
			440,
			412,
			"N clients with per-user auth = N query executions per write — groupBy collapses them",
		),
	].join("");
});

// ── 4. Conflict resolution ──────────────────────────────────────────────

export const conflict = frame(880, 330, (id) => {
	const mirror = [
		`<rect x="24" y="60" width="250" height="118" rx="4" class="nb nb-o"/>`,
		label(36, 82, "reflectdb mirror — todos/42", "start", "t1 tone-o"),
		label(36, 108, "title  @ …0050", "start", "t2"),
		label(36, 128, "body   @ …0200", "start", "t2"),
		label(36, 148, "_row   @ …0200", "start", "t2"),
	].join("");

	const incoming = node(
		320,
		84,
		240,
		70,
		["incoming, late", 'update { title: "Hello" }', "hlc …0100"],
		{ tone: "g" },
	);

	return [
		mirror,
		incoming,
		arrow(
			[
				[276, 119],
				[318, 119],
			],
			id,
			"m",
		),
		node(606, 44, 250, 66, ["lww — compare to _row", "0100 < 0200 → whole op rejected"], {
			tone: "fg",
		}),
		node(606, 122, 250, 66, ["merge — compare to title's clock", "0100 > 0050 → title accepted"], {
			tone: "g",
		}),
		node(606, 200, 250, 46, ["server — row exists → rejected"], { tone: "fg" }),
		node(606, 258, 250, 46, ["custom — your resolve() decides"], { tone: "fg" }),
		arrow(
			[
				[562, 110],
				[584, 110],
				[584, 77],
				[604, 77],
			],
			id,
			"m",
		),
		arrow(
			[
				[562, 128],
				[584, 128],
				[584, 155],
				[604, 155],
			],
			id,
			"g",
		),
		arrow(
			[
				[562, 134],
				[584, 134],
				[584, 223],
				[604, 223],
			],
			id,
			"m",
			true,
		),
		arrow(
			[
				[562, 140],
				[584, 140],
				[584, 281],
				[604, 281],
			],
			id,
			"m",
			true,
		),
		label(440, 316, "the same op, four policies, four outcomes"),
	].join("");
});

// ── 5. Consistent vs eager broadcast ────────────────────────────────────

export const broadcastModes = frame(880, 250, (id) => {
	const lane = (y: number, title: string, sub: string, tone: Tone, stages: string[]) => {
		let x = 210;
		const parts = [node(24, y, 170, 52, [title, sub], { tone, left: true })];
		for (const stage of stages) {
			const w = Math.max(96, stage.length * 6.6 + 20);
			parts.push(node(x, y + 8, w, 36, [stage], { tone: "fg" }));
			if (x > 210) {
				parts.push(
					arrow(
						[
							[x - 12, y + 26],
							[x - 2, y + 26],
						],
						id,
						tone,
					),
				);
			}
			x += w + 12;
		}
		parts.push(
			arrow(
				[
					[196, y + 26],
					[208, y + 26],
				],
				id,
				tone,
			),
		);
		return parts.join("");
	};

	return [
		label(24, 34, "TWO WAYS TO GET A DELTA OUT", "start", "hd"),
		lane(50, "consistent", "default", "b", [
			"pipeline",
			"mutate",
			"persist",
			"re-query",
			"diff",
			"delta",
		]),
		lane(126, "eager-durable", "no conflict pass", "g", ["gates", "mutate", "persist", "delta"]),
		label(
			24,
			218,
			"eager sends the row it was handed; consistent sends what your query returns afterwards.",
			"start",
		),
		label(24, 236, "both enforce readonly, serverSet, drift, batch cap and rate limits.", "start"),
	].join("");
});

// ── 6. Offline → reconnect → resume ─────────────────────────────────────

export const resume = frame(880, 520, (id) => {
	const CX = 180;
	const SX = 700;
	const msg = (y: number, from: "c" | "s", text: string, tone: Tone = "fg", dashed = false) => {
		const pts: Array<[number, number]> =
			from === "c"
				? [
						[CX + 8, y],
						[SX - 8, y],
					]
				: [
						[SX - 8, y],
						[CX + 8, y],
					];
		return [arrow(pts, id, tone, dashed), label(440, y - 7, text, "middle", "t2")].join("");
	};

	const note = (y: number, text: string) =>
		[
			`<rect x="${SX + 14}" y="${y - 13}" width="160" height="24" rx="3" class="nb nb-fg"/>`,
			label(SX + 24, y + 3, text, "start", "t2"),
		].join("");

	return [
		label(CX, 32, "client", "middle", "hd"),
		label(SX, 32, "server", "middle", "hd"),
		line([
			[CX, 128],
			[CX, 490],
		]),
		line([
			[SX, 44],
			[SX, 490],
		]),
		node(24, 60, 250, 62, ["offline", "insert/update keep working;", "ops pile up in IndexedDB"], {
			tone: "o",
			left: true,
		}),
		msg(150, "c", "hello { clientId, token, protocolVersion: 1 }", "g"),
		msg(186, "s", "hello_ack { serverId }", "b"),
		msg(222, "c", "sync_declare { table, params, window } × N", "g"),
		msg(258, "c", "resume { since: last serverHlc }", "g"),
		note(258, "getChangedTablesSince"),
		msg(310, "s", "snapshot — only queries whose tables changed", "b"),
		msg(346, "s", "resume_complete { serverHlc }", "b"),
		msg(382, "c", "ops[] — everything queued while offline", "g"),
		msg(418, "s", "ack [opIds]", "b"),
		msg(466, "s", 'resume_rejected { reason: "compacted" } → full bootstrap', "o", true),
		label(440, 508, "resume replays your query — not the op log — so tenant filters still apply"),
	].join("");
});

// ── 7. Two stores ───────────────────────────────────────────────────────

export const twoStores = frame(880, 330, (id) => {
	const write = node(330, 40, 220, 46, ["one accepted write"], { tone: "g" });
	const yours = node(
		60,
		140,
		300,
		70,
		["your database", "mutate() commits it — your schema,", "your constraints, your transaction"],
		{ tone: "o" },
	);
	const mirror = node(
		520,
		140,
		300,
		70,
		[
			"reflectdb mirror + op log",
			"JSONB row, per-column HLCs,",
			"one op-log entry — committed together",
		],
		{ tone: "b" },
	);

	return [
		write,
		yours,
		mirror,
		arrow(
			[
				[400, 88],
				[210, 88],
				[210, 138],
			],
			id,
			"o",
		),
		arrow(
			[
				[480, 88],
				[670, 88],
				[670, 138],
			],
			id,
			"b",
		),
		label(230, 116, "separate commits", "start"),
		node(
			60,
			240,
			300,
			56,
			["reads: snapshots, broadcast diffs", "everything the client ever sees"],
			{
				tone: "fg",
			},
		),
		node(520, 240, 300, 56, ["reads: conflict resolution,", "changed-tables-since, resume"], {
			tone: "fg",
		}),
		arrow(
			[
				[210, 212],
				[210, 238],
			],
			id,
			"m",
		),
		arrow(
			[
				[670, 212],
				[670, 238],
			],
			id,
			"m",
		),
		label(440, 322, "keep mutate a faithful apply of op.payload and the two never drift apart"),
	].join("");
});

// ── 7b. Object storage as the only durable store ────────────────────────

export const objectStorage = frame(880, 418, (id) => {
	const X = 60;
	const W = 560;
	const MID = X + W / 2;

	return [
		label(24, 34, "NO DATABASE — THE BUCKET IS DURABILITY, NEVER THE READ PATH", "start", "hd"),
		node(MID - 130, 54, 260, 38, ["one accepted write"], { tone: "g" }),
		arrow(
			[
				[MID, 94],
				[MID, 116],
			],
			id,
			"m",
		),
		node(
			X,
			118,
			W,
			84,
			[
				"writer instance — one room, one writer",
				"rows · per-column HLCs · op ring · reserveOp set",
				"authoritative in memory, so every read stops here",
			],
			{ tone: "b" },
		),
		label(644, 150, "getRow · getRows", "start"),
		label(644, 168, "getOpsSince · resume", "start"),
		label(644, 186, "— no network at all", "start"),
		arrow(
			[
				[MID, 204],
				[MID, 226],
			],
			id,
			"m",
		),
		node(
			X,
			228,
			W,
			66,
			[
				"write buffer ──▶ group commit",
				"exactly one flush in flight, so batch size tracks",
				"store latency on its own — there is no flushMs",
			],
			{ tone: "fg" },
		),
		arrow(
			[
				[MID, 296],
				[MID, 326],
			],
			id,
			"o",
		),
		label(644, 316, "1 PUT per batch,", "start"),
		label(644, 334, "then 1 CAS", "start"),
		node(
			X,
			328,
			W,
			76,
			[
				"object store — S3 · R2 · Tigris · MinIO · GCS",
				"wal/ write-once batches · snap/ materialized rows",
				"_manifest  compare-and-swapped: the one linearization point",
			],
			{ tone: "o" },
		),
		label(440, 414, "the CAS is what keeps the data correct — the writer lease is only an optimization"),
	].join("");
});

// ── 8. Module map ───────────────────────────────────────────────────────

export const modules = frame(880, 386, (id) => {
	const core = node(
		140,
		30,
		600,
		62,
		[
			"reflectdb/core — the only thing both sides import",
			"defineSyncQueries · t<T>() · HLC · SyncOp + message union · ErrorReason",
		],
		{ tone: "g" },
	);

	const server = node(24, 132, 400, 118, ["reflectdb/server", "", "", "", ""], {
		tone: "b",
		left: true,
	});
	const client = node(456, 132, 400, 118, ["reflectdb/client", "", "", "", ""], {
		tone: "b",
		left: true,
	});

	const serverLines = [
		"createSyncServer · implement / view / room / rest",
		"pipeline → op-processor → broadcast-engine",
		"result-cache · eager-buffer · replay-detector",
		"storage: memory | sqlite | postgres",
	]
		.map((s, i) => label(40, 178 + i * 16, s, "start", "t2"))
		.join("");

	const clientLines = [
		"createSyncClient · sync / insert / update / delete",
		"sync-client (state machine) · store (rows + queue)",
		"ops (HLC stamping) · typed-client",
		"storage: memory | indexeddb",
	]
		.map((s, i) => label(472, 178 + i * 16, s, "start", "t2"))
		.join("");

	return [
		core,
		server,
		client,
		serverLines,
		clientLines,
		arrow(
			[
				[380, 94],
				[224, 94],
				[224, 130],
			],
			id,
			"m",
		),
		arrow(
			[
				[500, 94],
				[656, 94],
				[656, 130],
			],
			id,
			"m",
		),
		node(
			24,
			274,
			832,
			44,
			[
				"reflectdb/transport — websocket · bun-ws · sse · polling",
				"handler functions you wire to your own routes; reflectdb ships no HTTP server",
			],
			{ tone: "o" },
		),
		node(
			24,
			330,
			832,
			44,
			[
				"reflectdb/react · /svelte · /vanilla · /htmx",
				"hooks, stores, callbacks and attributes over the same client — or use it directly",
			],
			{ tone: "g" },
		),
	].join("");
});

// ── 9. Client state machine ─────────────────────────────────────────────

export const stateMachine = frame(880, 200, (id) => {
	const states = [
		"hydrating",
		"disconnected",
		"connecting",
		"connected",
		"bootstrapping",
		"synced",
	];
	const w = 128;
	const gap = 16;
	const y = 56;
	const boxes = states
		.map((s, i) => {
			const x = 24 + i * (w + gap);
			return [
				node(x, y, w, 42, [s], { tone: i === states.length - 1 ? "g" : "fg" }),
				i > 0
					? arrow(
							[
								[x - gap + 2, y + 21],
								[x - 2, y + 21],
							],
							id,
							"m",
						)
					: "",
			].join("");
		})
		.join("");

	const last = 24 + (states.length - 1) * (w + gap);
	return [
		label(24, 34, "CLIENT STATE MACHINE", "start", "hd"),
		boxes,
		arrow(
			[
				[last + w / 2, y + 44],
				[last + w / 2, 140],
				[24 + 1 * (w + gap) + w / 2, 140],
				[24 + 1 * (w + gap) + w / 2, y + 46],
			],
			id,
			"o",
		),
		label(440, 158, "socket drops → exponential backoff with full jitter, capped at 30s"),
		label(
			440,
			178,
			"on reconnect: re-declare every subscription, resume from the watermark, re-push pending ops",
		),
	].join("");
});
