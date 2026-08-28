/**
 * The sync server for one kanban board, built fresh per serverless invocation.
 *
 * Every piece of durable state lives in an S3-compatible bucket — no Postgres,
 * no SQLite, no volume. Two things make that work on a platform where any
 * request can land on any instance:
 *
 *   1. `concurrency: "optimistic"` drops the writer lease. Instances race on the
 *      manifest CAS instead, and the loser re-reads and retries. The lease was
 *      only ever an optimization; the CAS is what keeps the data correct.
 *   2. `serverless: true` on the SSE transport returns each POST's replies in
 *      that POST's response, because the process holding the client's event
 *      stream is a different one and could never stream them.
 *
 * See docs/object-storage.md for the full design.
 */

import { MutationError } from "../../../src/core/index.ts";
import { MessageHandler } from "../../../src/server/handler.ts";
import { IncompleteStateError, createObjectStorage, roomPrefix } from "../../../src/server/storage/object/index.ts";
import { createFilesystemDriver } from "../../../src/server/storage/object/drivers/filesystem.ts";
import { createS3Driver } from "../../../src/server/storage/object/drivers/s3.ts";
import type { ObjectStorage } from "../../../src/server/storage/object/index.ts";
import { createSseServerTransport } from "../../../src/transport/sse.ts";
import type { ObjectDriver, StoreProvider } from "../../../src/server/storage/object/types.ts";
import { COLUMNS, type Card, type Column, isColumn } from "../schema.ts";

export type SseTransport = ReturnType<typeof createSseServerTransport>;

export interface Board {
	storage: ObjectStorage;
	transport: SseTransport;
	handler: MessageHandler;
	/**
	 * The same driver the storage adapter writes through, exposed because the
	 * periodic reset needs one key of its own — a claim marker that is not part
	 * of any room. See `lib/reset.ts`.
	 */
	driver: ObjectDriver;
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`Missing ${name}. The kanban example stores everything in an S3-compatible ` +
				`bucket; see examples/kanban/README.md for the variables to set.`,
		);
	}
	return value;
}

/**
 * Board id from the URL, normalized.
 *
 * It becomes an object-storage key prefix, so it is restricted rather than
 * escaped: a permissive id would let a visitor address another board's prefix,
 * and "looks like a slug" is a cheaper guarantee to reason about than "is
 * correctly encoded everywhere it is used".
 */
export function boardIdFrom(url: URL): string {
	const raw = url.searchParams.get("board") ?? "demo";
	const slug = raw.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 48);
	return slug.length > 0 ? slug : "demo";
}

/**
 * The object store every board shares, as a driver.
 *
 * `KANBAN_LOCAL_DIR` swaps the bucket for a directory so the example runs with
 * no credentials — the filesystem driver has the same CAS semantics, and the
 * whole conformance suite runs against both. It is for local development only:
 * a filesystem cannot make compare-then-rename atomic across processes, which is
 * exactly the guarantee the manifest depends on.
 *
 * One driver rather than one per room: rooms are namespaced by key prefix
 * (`rooms/<board>/`), so the same connection serves every board, and the reset
 * marker lives beside them under `resets/`.
 */
export function createKanbanDriver(): ObjectDriver {
	const localDir = process.env.KANBAN_LOCAL_DIR;
	if (localDir) return createFilesystemDriver(localDir);

	return createS3Driver({
		provider: (process.env.S3_PROVIDER ?? "r2") as StoreProvider,
		bucket: required("S3_BUCKET"),
		// R2 derives its endpoint from the account id; the other providers
		// either have a well-known one or take S3_ENDPOINT.
		accountId: process.env.R2_ACCOUNT_ID,
		endpoint: process.env.S3_ENDPOINT,
		region: process.env.S3_REGION,
		credentials: {
			keyId: required("S3_ACCESS_KEY_ID"),
			secret: required("S3_SECRET_ACCESS_KEY"),
		},
		prefix: "kanban",
	});
}

/** Storage config for one board on an already-built driver. */
function objectStorageConfig(
	boardId: string,
	driver: ObjectDriver,
): Parameters<typeof createObjectStorage>[0] {
	return {
		roomId: boardId,
		driver,
		// The whole reason this runs on Vercel at all — see the file header.
		concurrency: "optimistic" as const,
		// A board is small and rarely written, so compact eagerly: boot cost is one
		// GET per WAL segment, and a visitor opening a cold board pays it.
		compaction: { afterSegments: 40 },
	};
}

/**
 * Builds the handler and storage for one invocation.
 *
 * Deliberately NOT cached across invocations. A warm Fluid instance could reuse
 * it, but the adapter's in-memory state would then be as stale as the last
 * request that touched it — and correctness here depends on `refresh()` being
 * called deliberately, not on a cache happening to be warm. The cost is one
 * manifest GET per request, which is what the design is built around.
 */
export function createBoard(boardId: string): Board {
	const driver = createKanbanDriver();
	const storage = createObjectStorage(objectStorageConfig(boardId, driver));

	const transport = createSseServerTransport({ serverless: true });
	const handler = new MessageHandler({
		transport,
		serverId: `kanban-${boardId}`,
		db: {},
		// The demo is deliberately open: anyone with the link edits the board.
		// Swap in a real auth() callback to gate it.
		allowAnonymous: true,
	});
	handler.setStorage(storage);

	handler.setQuery("cards", {
		name: "cards",
		callback: async () => (await storage.getRows("cards")).rows as unknown as Card[],
		tableDependencies: new Set(["cards"]),
		options: {
			tables: ["cards"],
			// Per-column merge: two people dragging different cards, or renaming a
			// title while someone else moves it, both land. Last-write-wins would
			// let the slower write clobber an unrelated field.
			conflict: "merge",
			mutate: async (op) => {
				if (op.type === "delete") {
					await storage.putRow("cards", op.rowId, null, {}, op.hlc);
					return;
				}

				// REJECT rather than coerce. The pipeline mirrors `op.payload` into
				// the row store itself — `mutate` is not the only writer — so quietly
				// substituting a valid value here would leave the bad one in the
				// mirror that conflict resolution compares against. Throwing is what
				// actually stops the write, and `MutationError` is what carries a
				// reason through to the client's `onError`; a plain Error arrives as
				// an opaque `server_error`.
				//
				// It is also the better product behaviour: silently moving someone's
				// card to a column they did not pick is worse than refusing the edit.
				const payload = (op.payload ?? {}) as Partial<Card>;
				// The pipeline mirrors `op.payload` into the row store, and the query's
				// primary key is `id`, so a payload without it produces rows that all
				// key to "" — the board then renders one card no matter how many exist.
				// Stamped from the op's rowId rather than trusted from the client, so a
				// payload claiming someone else's id cannot overwrite their row.
				if (payload.id !== undefined && payload.id !== op.rowId) {
					throw new MutationError("outside_shape", "id must match the row id");
				}
				if (payload.column !== undefined && !isColumn(payload.column)) {
					throw new MutationError(
						"outside_shape",
						`column must be one of ${COLUMNS.join(", ")}`,
					);
				}
				if (payload.title !== undefined) {
					if (typeof payload.title !== "string" || payload.title.length > 200) {
						throw new MutationError("outside_shape", "title must be a string of at most 200 characters");
					}
				}
				if (payload.position !== undefined && !Number.isFinite(payload.position)) {
					throw new MutationError("outside_shape", "position must be a finite number");
				}

				// An update carries a partial delta, so merge onto what is stored
				// rather than writing the delta as if it were a whole row.
				const existing = (await storage.getRow("cards", op.rowId)).row as Card | null;
				await storage.putRow(
					"cards",
					op.rowId,
					{
						id: op.rowId,
						title: payload.title ?? existing?.title ?? "",
						column: (payload.column as Column) ?? existing?.column ?? COLUMNS[0],
						position: payload.position ?? existing?.position ?? 0,
					},
					{},
					op.hlc,
				);
			},
		},
	});

	return { storage, transport, handler, driver };
}

/**
 * Tears down one invocation's board.
 *
 * Handler first, storage second, and the order is load-bearing: the handler's
 * final act is persisting its HLC watermark, which is a write. Closing storage
 * first leaves that write to fail against a closed room — the next boot then
 * resumes below HLCs this instance already handed out, and every invocation
 * logs the failure on its way down.
 */
/**
 * A board, booted — clearing it first if the store lost an object it named.
 *
 * `IncompleteStateError` means the manifest points at a key the bucket no
 * longer has, which is unrecoverable by design: the adapter refuses to boot
 * rather than present the loss as an empty room. For a demo board that is the
 * wrong end state, because the room is disposable — it already resets itself
 * every five minutes — and the alternative is a board that answers 500 forever,
 * which is what happened to `demo` when two writers picked the same snapshot
 * name.
 *
 * **Do not copy this into an application that keeps real data.** There the
 * correct response is to page someone: the refusal is telling you the store
 * lost an acknowledged write, and clearing the room throws away whatever
 * survived along with the evidence.
 */
export async function openBoard(boardId: string): Promise<Board> {
	const board = createBoard(boardId);
	try {
		await board.storage.init();
		return board;
	} catch (error) {
		await closeQuietly(board);
		if (!(error instanceof IncompleteStateError)) throw error;

		console.error(
			`[kanban] room "${boardId}" cannot boot: ${error.key} is gone from the bucket. ` +
				`Clearing the room and starting it over — the cards it held are lost.`,
		);
		const driver = createKanbanDriver();
		const keys = (await driver.list(roomPrefix(boardId))).map((entry) => entry.key);
		if (keys.length > 0) await driver.delete(keys);

		const fresh = createBoard(boardId);
		await fresh.storage.init();
		return fresh;
	}
}

/** Closing a board that never booted is best-effort; the boot error is the one that matters. */
async function closeQuietly(board: Board): Promise<void> {
	try {
		await closeBoard(board);
	} catch {
		/* the caller is already handling a failure */
	}
}

export async function closeBoard(board: Board): Promise<void> {
	await board.handler.close();
	await board.storage.close();
}
