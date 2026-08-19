import { serve } from "bun";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { createBunWsServerTransport } from "../../src/transport/bun-ws.ts";
import { createSyncServer } from "../../src/server/typed-server.ts";
import type { ResolvedOp } from "../../src/server/types.ts";
import { auth } from "./auth.ts";
import { IS_PRODUCTION, PORT } from "./config.ts";
import {
	queries,
	games,
	gameSecrets,
	players,
	strokes,
	messages,
	createDb,
	pickWordOptions,
	maskWord,
	mutateGame,
	mutatePlayer,
	mutateStroke,
} from "./schema.ts";
import type { AppAuth, RoundWord } from "./schema.ts";

const { db, sqlite, storage } = createDb();

// ── Build client bundle ─────────────────────────────────────────────────

// The Docker image bundles `app.js` ahead of time so the deployed Machine
// never pays for a build; `bun dev` rebuilds on every request instead, so an
// edit to app.tsx is one refresh away.
async function buildClient(): Promise<string> {
	if (IS_PRODUCTION) {
		return Bun.file(import.meta.dir + "/app.js").text();
	}
	const result = await Bun.build({
		entrypoints: [import.meta.dir + "/render.tsx"],
		target: "browser",
		minify: false,
	});
	return result.outputs[0]!.text();
}

async function clientHtml(): Promise<string> {
	const raw = await Bun.file(import.meta.dir + "/index.html").text();
	return raw.replace(
		'<script type="module" src="./render.tsx"></script>',
		'<script type="module" src="/app.js"></script>',
	);
}

// ── WS Transport ────────────────────────────────────────────────────────

const { transport, websocket } = createBunWsServerTransport({
	maxMessageBytes: 1_000_000,
	pingIntervalMs: 30_000,
});

// ── Sync server ─────────────────────────────────────────────────────────

const server = createSyncServer<typeof queries, BunSQLiteDatabase, AppAuth>({
	queries,
	db,
	transport,
	storage,
	serverId: "whiteboard",
	maxConnectionsPerUser: 5,
});

server.rateLimit({
	opsPerSecond: 200,
	perTable: {
		strokes: { opsPerSecond: 100 },
		messages: { opsPerSecond: 5 },
	},
});

server.auth(async (req) => {
	const session = await auth.api.getSession({ headers: req.headers });
	if (!session) throw new Error("unauthorized");
	return {
		userId: session.user.id,
		name: session.user.name || `Guest ${session.user.id.slice(0, 4)}`,
	};
});

// ── Pictionary engine ───────────────────────────────────────────────────

interface ScoreEntry {
	name: string;
	score: number;
}

function loadScores(raw: string): Record<string, ScoreEntry> {
	try {
		return JSON.parse(raw) as Record<string, ScoreEntry>;
	} catch {
		return {};
	}
}

function loadList(raw: string): string[] {
	try {
		const arr = JSON.parse(raw);
		return Array.isArray(arr) ? (arr as string[]) : [];
	} catch {
		return [];
	}
}

async function postSystemMessage(gameId: string, text: string, kind = "system") {
	const id = crypto.randomUUID();
	await db.insert(messages).values({
		id,
		gameId,
		text,
		kind,
		createdBy: "Game",
		createdByUserId: "",
		createdAt: new Date(),
	});
	await server.notifyChange("messages");
}

const PICK_DURATION_MS = 15_000;
const ROUND_END_PAUSE_MS = 5_000;

// reflectdb excludes a writer from the broadcast for its own op — that client
// already applied it optimistically. A room's creator therefore holds the row
// it sent, not the row the server stored, and the engine columns the insert
// path fills in server-side (`state` above all, which the Pictionary HUD keys
// off) would stay missing until that tab left the room and came back. One
// deferred notify after the op settles makes the writer re-query and pick the
// complete row up. Coalesced so a burst of creates costs one query.
let gamesReconciliationQueued = false;
function queueGamesReconciliation(): void {
	if (gamesReconciliationQueued) return;
	gamesReconciliationQueued = true;
	setTimeout(() => {
		gamesReconciliationQueued = false;
		server.notifyChange("games").catch((error) => {
			console.error("[games reconciliation]", error);
		});
	}, 0);
}

// Writes the secret row WITHOUT notifying. Callers should batch this with
// any games-row update so subscribers re-run queries against fully consistent
// state, avoiding empty-row flashes during transitions.
async function writeSecret(gameId: string, word: string, options: string[] = []) {
	await db
		.insert(gameSecrets)
		.values({ gameId, word, options: JSON.stringify(options) })
		.onConflictDoUpdate({
			target: gameSecrets.gameId,
			set: { word, options: JSON.stringify(options) },
		});
}

async function setSecret(gameId: string, word: string, options: string[] = []) {
	await writeSecret(gameId, word, options);
	await server.notifyChange("game_secrets");
}

async function getSecret(gameId: string): Promise<{ word: string; options: string[] }> {
	const row = await db
		.select()
		.from(gameSecrets)
		.where(eq(gameSecrets.gameId, gameId))
		.get();
	return {
		word: row?.word ?? "",
		options: row ? loadList(row.options) : [],
	};
}

// Picking phase: the next drawer chooses one of three words within
// PICK_DURATION_MS. After the timer expires the engine auto-picks the
// first option.
async function startPicking(gameId: string) {
	const game = await db.select().from(games).where(eq(games.id, gameId)).get();
	if (!game) return;

	const order = loadList(game.playerOrder);
	if (order.length < 2) {
		await db
			.update(games)
			.set({
				state: "waiting",
				currentDrawerId: "",
				currentDrawerName: "",
				wordMask: "",
				wordLength: 0,
				roundEndsAt: 0,
			})
			.where(eq(games.id, gameId));
		await server.notifyChange("games");
		await setSecret(gameId, "", []);
		return;
	}

	const playersList = await db.select().from(players).where(eq(players.gameId, gameId));
	const playerByUserId = new Map(playersList.map((p) => [p.userId, p]));

	const prevIdx = game.currentDrawerId ? order.indexOf(game.currentDrawerId) : -1;
	const nextIdx = (prevIdx + 1) % order.length;
	const nextRound = prevIdx === -1 || nextIdx === 0 ? game.currentRound + 1 : game.currentRound;

	if (nextRound > game.totalRounds) {
		await db
			.update(games)
			.set({
				state: "finished",
				currentDrawerId: "",
				currentDrawerName: "",
				wordMask: "",
				wordLength: 0,
				roundEndsAt: 0,
			})
			.where(eq(games.id, gameId));
		await server.notifyChange("games");
		await setSecret(gameId, "", []);
		await postSystemMessage(gameId, "Game over!");
		return;
	}

	const drawerUserId = order[nextIdx]!;
	const drawerName = playerByUserId.get(drawerUserId)?.name ?? "?";
	const options = pickWordOptions(3);

	await db.delete(strokes).where(eq(strokes.gameId, gameId));

	await db
		.update(games)
		.set({
			state: "picking",
			currentRound: nextRound,
			currentDrawerId: drawerUserId,
			currentDrawerName: drawerName,
			wordMask: "",
			wordLength: 0,
			roundEndsAt: Date.now() + PICK_DURATION_MS,
			correctGuessers: "[]",
		})
		.where(eq(games.id, gameId));
	// Write the secret BEFORE notifying so the drawer's first re-query sees a
	// consistent (state=picking, options=...) snapshot.
	await writeSecret(gameId, "", options);

	await server.notifyChange("games");
	await server.notifyChange("strokes");
	await server.notifyChange("game_secrets");
	await postSystemMessage(
		gameId,
		`Round ${nextRound} of ${game.totalRounds} — ${drawerName} is choosing a word...`,
	);
}

// Drawer locked in a word (or auto-picked by tick).
async function startDrawing(gameId: string, word: string) {
	const game = await db.select().from(games).where(eq(games.id, gameId)).get();
	if (!game || game.state !== "picking") return;

	await db
		.update(games)
		.set({
			state: "drawing",
			wordMask: maskWord(word),
			wordLength: word.length,
			roundEndsAt: Date.now() + game.roundDurationSec * 1000,
		})
		.where(eq(games.id, gameId));
	// Replace options with the chosen word atomically (DB-level) before any
	// notifyChange so the drawer's HUD never flashes between picker → empty.
	await writeSecret(gameId, word, []);

	await server.notifyChange("games");
	await server.notifyChange("game_secrets");
	await postSystemMessage(gameId, `${game.currentDrawerName} is drawing now!`);
}

async function endRound(gameId: string, reason: "time" | "all_guessed") {
	const game = await db.select().from(games).where(eq(games.id, gameId)).get();
	if (!game || game.state !== "drawing") return;

	const { word } = await getSecret(gameId);

	await db
		.update(games)
		.set({ state: "round_end", roundEndsAt: Date.now() + ROUND_END_PAUSE_MS })
		.where(eq(games.id, gameId));
	await writeSecret(gameId, "", []);
	await server.notifyChange("games");
	await server.notifyChange("game_secrets");

	const note =
		reason === "time"
			? `Time's up! The word was "${word}".`
			: `Everyone guessed "${word}"!`;
	await postSystemMessage(gameId, note);
}

// Per-game serialized work queue. Engine actions (start, reset, end, advance,
// score updates) chain through this so concurrent guesses or actions can't
// trample each other's read-modify-write on games.scores / correctGuessers.
const gameLocks = new Map<string, Promise<unknown>>();

async function withLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
	const prev = gameLocks.get(gameId) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	const tracked = next.catch(() => undefined);
	gameLocks.set(gameId, tracked);
	try {
		return await next;
	} finally {
		// Drop the entry once the chain has fully drained so tryLock can
		// engage again. Only delete if no later caller chained behind us.
		if (gameLocks.get(gameId) === tracked) {
			gameLocks.delete(gameId);
		}
	}
}

// Skip-if-busy variant for the timer tick — never queues, just bails when
// another caller already holds the lock.
async function tryLock<T>(gameId: string, fn: () => Promise<T>): Promise<T | undefined> {
	if (gameLocks.has(gameId)) return undefined;
	return await withLock(gameId, fn);
}

async function tick() {
	const now = Date.now();
	const active = await db.select().from(games).where(eq(games.mode, "pictionary"));

	for (const g of active) {
		if (g.state === "drawing" && g.roundEndsAt > 0 && now >= g.roundEndsAt) {
			await tryLock(g.id, () => endRound(g.id, "time"));
		} else if (g.state === "round_end" && g.roundEndsAt > 0 && now >= g.roundEndsAt) {
			await tryLock(g.id, () => startPicking(g.id));
		} else if (g.state === "picking" && g.roundEndsAt > 0 && now >= g.roundEndsAt) {
			// Drawer ran out of time — auto-pick. Falls back to a random word
			// from the global pool if the options row got wiped somehow.
			await tryLock(g.id, async () => {
				const { options } = await getSecret(g.id);
				const fallback = options[0] ?? pickWordOptions(1)[0]!;
				await startDrawing(g.id, fallback);
			});
		}
	}
}

const tickInterval = setInterval(() => {
	tick().catch((e) => console.error("[pictionary tick]", e));
}, 500);

// Bun --hot reloads this module without killing timers from the previous
// version. Without dispose, every reload doubles the engine tick rate.
if (import.meta.hot) {
	import.meta.hot.dispose(() => clearInterval(tickInterval));
}

// Columns the round engine owns outright. A client insert has them clamped to
// these values; a client update has them dropped. The schema marks them
// `readonly` for the same reason, but a mutate is handed the op resolved
// against the stored row, so they still arrive here — dropping them is what
// keeps a hand-written op from seeding a round.
const ENGINE_DEFAULTS: Record<string, string | number> = {
	state: "waiting",
	currentDrawerId: "",
	currentDrawerName: "",
	wordMask: "",
	wordLength: 0,
	roundEndsAt: 0,
	currentRound: 0,
	playerOrder: "[]",
	scores: "{}",
	correctGuessers: "[]",
};
const ENGINE_FIELDS = Object.keys(ENGINE_DEFAULTS);

// ── Game-action mutate (kicks off rounds when client sets state="starting") ──

async function mutateGameWithEngine(
	op: ResolvedOp,
	ctx: { auth: AppAuth },
	d: BunSQLiteDatabase,
) {
	const incoming = (op.payload ?? {}) as Record<string, unknown>;
	const requestedAction = incoming._action as string | undefined;
	delete incoming._action;

	if (op.type === "delete") {
		await mutateGame(op, ctx, d);
		return;
	}

	if (op.type === "insert") {
		// Validate the user-writable fields we still trust on insert.
		if (incoming.mode !== "freeform" && incoming.mode !== "pictionary") {
			throw new Error("invalid game mode");
		}
		const total = Number(incoming.totalRounds ?? 3);
		const dur = Number(incoming.roundDurationSec ?? 75);
		if (!Number.isFinite(total) || total < 1 || total > 10) {
			throw new Error("totalRounds must be 1-10");
		}
		if (!Number.isFinite(dur) || dur < 15 || dur > 300) {
			throw new Error("roundDurationSec must be 15-300");
		}
		incoming.totalRounds = total;
		incoming.roundDurationSec = dur;

		// Clamp engine-controlled fields so a malicious client can't seed state.
		for (const field of ENGINE_FIELDS) incoming[field] = ENGINE_DEFAULTS[field];
		await mutateGame(op, ctx, d);
		queueGamesReconciliation();
	} else {
		// An update's resolved payload carries the engine's own columns back to
		// us alongside whatever the client changed. Only the engine writes
		// those — and `createdAt` is stamped per op, so persisting it here
		// would keep bumping a room to the top of the lobby. Drop both sets and
		// keep only what a client may actually change.
		for (const field of ENGINE_FIELDS) delete incoming[field];
		delete incoming.createdAt;
		// Only persist if there's something user-writable left after stripping the action.
		if (Object.keys(incoming).length > 0) await mutateGame(op, ctx, d);
	}

	if (!requestedAction) return;

	await withLock(op.rowId, async () => {
		const game = await d.select().from(games).where(eq(games.id, op.rowId)).get();
		if (!game) return;

		if (requestedAction === "start" && game.mode === "pictionary") {
			if (game.state !== "waiting" && game.state !== "finished") return;

			const playersList = await d
				.select()
				.from(players)
				.where(eq(players.gameId, op.rowId))
				.orderBy(players.joinedAt);

			if (playersList.length < 2) {
				throw new Error("need at least 2 players to start pictionary");
			}

			const order = playersList.map((p) => p.userId);
			const scores: Record<string, ScoreEntry> = {};
			for (const p of playersList) scores[p.userId] = { name: p.name, score: 0 };

			await d
				.update(games)
				.set({
					state: "round_end",
					currentRound: 0,
					currentDrawerId: "",
					currentDrawerName: "",
					wordMask: "",
					wordLength: 0,
					playerOrder: JSON.stringify(order),
					scores: JSON.stringify(scores),
					correctGuessers: "[]",
					roundEndsAt: Date.now() + 1500,
				})
				.where(eq(games.id, op.rowId));
			await server.notifyChange("games");
			await setSecret(op.rowId, "", []);
			await postSystemMessage(op.rowId, "Game starting...");
		} else if (requestedAction === "reset") {
			await d
				.update(games)
				.set({
					state: "waiting",
					currentRound: 0,
					currentDrawerId: "",
					currentDrawerName: "",
					wordMask: "",
					wordLength: 0,
					roundEndsAt: 0,
					scores: "{}",
					correctGuessers: "[]",
					playerOrder: "[]",
				})
				.where(eq(games.id, op.rowId));
			await d.delete(strokes).where(eq(strokes.gameId, op.rowId));
			await server.notifyChange("games");
			await server.notifyChange("strokes");
			await setSecret(op.rowId, "", []);
			await postSystemMessage(op.rowId, "Game reset");
		} else if (requestedAction.startsWith("pick:")) {
			if (game.state !== "picking") return;
			if (game.currentDrawerId !== ctx.auth.userId) {
				throw new Error("only the drawer can pick");
			}
			const word = requestedAction.slice("pick:".length);
			const { options } = await getSecret(op.rowId);
			if (!options.includes(word)) {
				throw new Error("invalid word choice");
			}
			await startDrawing(op.rowId, word);
		}
	});
}

// ── Message mutate w/ guess detection ───────────────────────────────────

async function mutateMessageWithGuesses(
	op: ResolvedOp,
	ctx: { auth: AppAuth; params: Record<string, unknown> },
	d: BunSQLiteDatabase,
) {
	const payload = { ...(op.payload ?? {}) } as Record<string, unknown>;

	if (op.type === "delete") {
		const existing = await d
			.select()
			.from(messages)
			.where(eq(messages.id, op.rowId))
			.get();
		if (existing && existing.createdByUserId !== ctx.auth.userId) {
			throw new Error("only the author can delete a message");
		}
		await d.delete(messages).where(eq(messages.id, op.rowId));
		return;
	}

	if (op.type === "insert") {
		if (payload.gameId !== ctx.params.gameId) {
			throw new Error("gameId mismatch");
		}
		delete payload.id; // op.rowId is authoritative
		payload.createdBy = ctx.auth.name;
		payload.createdByUserId = ctx.auth.userId;
		payload.kind = "chat";

		const gameId = payload.gameId as string | undefined;
		const text = (payload.text as string) ?? "";
		const game = gameId
			? await d.select().from(games).where(eq(games.id, gameId)).get()
			: undefined;

		// Drawer cannot chat mid-round — they could leak either the picked
		// word (state="drawing") or one of their candidate options
		// (state="picking") to other players.
		if (
			game?.mode === "pictionary" &&
			(game.state === "drawing" || game.state === "picking") &&
			ctx.auth.userId === game.currentDrawerId
		) {
			throw new Error("drawer cannot chat during their round");
		}

		// A guesser who already guessed correctly stops chatting too.
		if (
			game?.mode === "pictionary" &&
			game.state === "drawing" &&
			loadList(game.correctGuessers).includes(ctx.auth.userId)
		) {
			throw new Error("you already guessed — wait for the round to end");
		}

		if (
			game?.mode === "pictionary" &&
			game.state === "drawing" &&
			ctx.auth.userId !== game.currentDrawerId
		) {
			const guess = text.trim().toLowerCase();
			const word = (await getSecret(gameId!)).word.toLowerCase();

			if (guess === word) {
				const scored = await withLock(gameId!, async () => {
					// Re-read inside the lock — another guesser may have updated
					// scores / correctGuessers between our pre-lock read and now.
					const fresh = await d
						.select()
						.from(games)
						.where(eq(games.id, gameId!))
						.get();
					if (!fresh || fresh.state !== "drawing") return null;
					const freshGuessers = loadList(fresh.correctGuessers);
					if (freshGuessers.includes(ctx.auth.userId)) return null;

					const scores = loadScores(fresh.scores);
					const order = loadList(fresh.playerOrder);
					const remainingMs = Math.max(0, fresh.roundEndsAt - Date.now());
					const points =
						50 + Math.floor((remainingMs / (fresh.roundDurationSec * 1000)) * 100);

					scores[ctx.auth.userId] = scores[ctx.auth.userId] ?? {
						name: ctx.auth.name,
						score: 0,
					};
					scores[ctx.auth.userId]!.score += points;

					const drawer = scores[fresh.currentDrawerId];
					if (drawer) drawer.score += 25;

					freshGuessers.push(ctx.auth.userId);

					await d
						.update(games)
						.set({
							scores: JSON.stringify(scores),
							correctGuessers: JSON.stringify(freshGuessers),
						})
						.where(eq(games.id, gameId!));

					await server.notifyChange("games");

					const nonDrawerCount = order.filter(
						(u) => u !== fresh.currentDrawerId,
					).length;
					const allGuessed = freshGuessers.length >= nonDrawerCount;
					return { remainingMs, points, allGuessed };
				});

				if (scored) {
					payload.text = `🎉 guessed in ${Math.round(scored.remainingMs / 1000)}s (+${scored.points})`;
					payload.kind = "correct";
					await d.insert(messages).values({
						...payload,
						id: op.rowId,
					} as typeof messages.$inferInsert);
					if (scored.allGuessed) {
						await withLock(gameId!, () => endRound(gameId!, "all_guessed"));
					}
					return;
				}
				// Round ended or this user was already credited. Drop the message
				// rather than letting the raw guess text broadcast as chat.
				throw new Error("guess no longer valid");
			}

			// Close-but-not-quite hint (within edit distance 1)
			if (guess.length > 0 && word.length > 0 && levenshtein(guess, word) === 1) {
				payload.kind = "close";
			}
		}

		await d
			.insert(messages)
			.values({ ...payload, id: op.rowId } as typeof messages.$inferInsert);
		return;
	}

	// update
	delete payload.id;
	await d
		.insert(messages)
		.values({ ...payload, id: op.rowId } as typeof messages.$inferInsert)
		.onConflictDoUpdate({ target: messages.id, set: payload });
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	const m = a.length;
	const n = b.length;
	if (m === 0 || n === 0) return Math.max(m, n);
	const prev = new Array(n + 1).fill(0).map((_, i) => i);
	const curr = new Array(n + 1).fill(0);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
		}
		for (let j = 0; j <= n; j++) prev[j] = curr[j];
	}
	return prev[n]!;
}

// ── Implement queries ───────────────────────────────────────────────────

server.implement("games", {
	query: (_ctx, d) => d.select().from(games),
	mutate: mutateGameWithEngine as never,
	serverSet: { createdAt: () => new Date() },
});

server.implement("players", {
	query: (ctx, d) =>
		d.select().from(players).where(eq(players.gameId, ctx.params.gameId as string)),
	mutate: mutatePlayer as never,
	serverSet: { joinedAt: () => new Date() },
	tables: ["players"],
});

server.implement("strokes", {
	query: (ctx, d) =>
		d.select().from(strokes).where(eq(strokes.gameId, ctx.params.gameId as string)),
	mutate: mutateStroke as never,
	serverSet: { createdAt: () => new Date() },
	tables: ["strokes"],
});

server.implement("messages", {
	query: (ctx, d) =>
		d.select().from(messages).where(eq(messages.gameId, ctx.params.gameId as string)),
	mutate: mutateMessageWithGuesses as never,
	serverSet: { createdAt: () => new Date() },
	tables: ["messages"],
});

// roundWord — drawer-only view of secret state. During "picking" the
// drawer receives `options` (3 candidate words). During "drawing" they
// receive `word`. Guessers always get an empty array.
server.implement("roundWord", {
	query: async (ctx, d): Promise<RoundWord[]> => {
		const gameId = ctx.params.gameId as string;
		const game = await d.select().from(games).where(eq(games.id, gameId)).get();
		if (!game) return [];
		if (game.state !== "picking" && game.state !== "drawing") return [];
		if (game.currentDrawerId !== ctx.auth.userId) return [];
		const secret = await d
			.select()
			.from(gameSecrets)
			.where(eq(gameSecrets.gameId, gameId))
			.get();
		if (!secret) return [];
		// Only emit a row if there's something to show — avoids spurious
		// inserts/deletes during the brief gap between state and secret writes.
		if (game.state === "picking" && (!secret.options || secret.options === "[]")) return [];
		if (game.state === "drawing" && !secret.word) return [];
		return [
			{
				id: gameId,
				gameId,
				word: secret.word,
				options: secret.options,
			},
		];
	},
	mutate: async () => {
		throw new Error("roundWord is read-only");
	},
	tables: ["games", "game_secrets"],
});

// ── HTTP server ─────────────────────────────────────────────────────────

const httpServer = serve({
	port: PORT,
	websocket,
	async fetch(req, srv) {
		const url = new URL(req.url);

		if (url.pathname.startsWith("/api/auth")) {
			return auth.handler(req);
		}

		if (url.pathname === "/sync") {
			if (
				srv.upgrade(req, {
					data: { id: `ws-${Math.random().toString(36).slice(2, 8)}`, req },
				})
			) {
				return;
			}
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		if (url.pathname === "/app.js") {
			return new Response(await buildClient(), {
				headers: { "content-type": "application/javascript", "cache-control": "no-store" },
			});
		}

		return new Response(await clientHtml(), {
			headers: { "content-type": "text/html", "cache-control": "no-store" },
		});
	},
});

console.log(`Whiteboard running at http://localhost:${httpServer.port}`);

// Fly stops an idle Machine with SIGTERM. Draining the WebSocket transport and
// closing SQLite before exiting means the last strokes and chat lines are
// checkpointed into the database file rather than left in the WAL.
if (IS_PRODUCTION) {
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`Received ${signal}; closing whiteboard cleanly`);
		clearInterval(tickInterval);
		await httpServer.stop(true);
		await server.close();
		sqlite.close();
		process.exit(0);
	};
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
	process.once("SIGINT", () => void shutdown("SIGINT"));
}
