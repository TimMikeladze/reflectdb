import type { DrizzleTableLike } from "../core/schema.ts";
import { nodeRequire } from "./node-require.ts";
import type { AuthContext } from "../core/types.ts";
import {
	defineTable,
	type DefineTableOpts,
	type TableAdapter,
} from "./factory.ts";
import type { TxAtomicAdapter } from "./tx-atomic.ts";
import type { AuthorizeAction, MutationContext, ResolvedOp } from "./types.ts";

// `SQL` is a TYPE-only import — erased at runtime, no module load.
type SQL = import("drizzle-orm").SQL;

// ── Lazy drizzle helpers ────────────────────────────────────────────────

// `nodeRequire` synchronously resolves `drizzle-orm` only when a drizzle code
// path runs. The module re-exports `drizzleTable` from `reflectdb/server`; if
// drizzle isn't installed (kysely / prisma / raw-SQL apps), top-level
// evaluation here MUST NOT touch drizzle-orm.

interface DrizzleHelpers {
	eq: typeof import("drizzle-orm").eq;
	sql: typeof import("drizzle-orm").sql;
	getTableName: typeof import("drizzle-orm").getTableName;
}

let cachedDrizzle: DrizzleHelpers | null | undefined;

function loadDrizzleSync(): DrizzleHelpers {
	if (cachedDrizzle === undefined) {
		try {
			const mod = nodeRequire("drizzle-orm") as DrizzleHelpers;
			cachedDrizzle = { eq: mod.eq, sql: mod.sql, getTableName: mod.getTableName };
		} catch {
			cachedDrizzle = null;
		}
	}
	if (!cachedDrizzle) {
		throw new Error(
			"drizzleTable / drizzleTxAtomic require drizzle-orm to be installed. Add it to your dependencies, or use defineTable with a custom TableAdapter.",
		);
	}
	return cachedDrizzle;
}

// ── Drizzle-specific scope typing ───────────────────────────────────────

type Ctx<TAuth extends AuthContext, TParams extends Record<string, unknown>> = {
	auth: TAuth;
	params: TParams;
};

type DrizzleScopeFn<TAuth extends AuthContext, TParams extends Record<string, unknown>> = (
	ctx: Ctx<TAuth, TParams>,
) => SQL;

type DrizzleScopeOpt<
	TRowKey extends string,
	TAuth extends AuthContext,
	TParams extends Record<string, unknown>,
> =
	| TRowKey
	| { auth: keyof TAuth & string; column: TRowKey }
	| DrizzleScopeFn<TAuth, TParams>;

/**
 * Drizzle-flavored options. Identical surface to `DefineTableOpts` except the
 * row type is derived from `$inferSelect` and function-form scope returns
 * drizzle's `SQL` (vs. the generic factory's `unknown`). Kept for backward
 * compat with the existing public `drizzleTable<TTable, ...>(opts)` call shape.
 */
export interface DrizzleTableOpts<
	TTable extends DrizzleTableLike,
	TAuth extends AuthContext = AuthContext,
	TParams extends Record<string, unknown> = Record<string, unknown>,
> extends Omit<DefineTableOpts<TTable["$inferSelect"], TAuth, TParams>, "scope"> {
	scope?: DrizzleScopeOpt<keyof TTable["$inferSelect"] & string, TAuth, TParams>;
}

// ── execAll: normalize sqlite/pg drizzle return shapes ─────────────────

// Drizzle bun-sqlite returns a builder with .get()/.all(); pg returns a thenable
// that resolves to an array. Normalize: prefer .all() if present, else await.
async function execAll(query: unknown): Promise<Record<string, unknown>[]> {
	const q = query as { all?: () => unknown; then?: unknown };
	if (q && typeof q.all === "function") {
		return (await Promise.resolve(q.all())) as Record<string, unknown>[];
	}
	const res = await Promise.resolve(query as Promise<unknown>);
	return Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
}

// ── Drizzle adapter ────────────────────────────────────────────────────

/**
 * Build a TableAdapter from a drizzle table. Preserves today's idempotent
 * upsert + scope-filter SQL so the existing `drizzleTable` API is unchanged.
 *
 * `name` is filled lazily on first method call — drizzle-orm is loaded
 * dynamically so this module can be imported without drizzle installed.
 */
function drizzleAdapter<TTable extends DrizzleTableLike>(
	table: TTable,
	pk?: string,
): TableAdapter<TTable["$inferSelect"]> {
	const pkName = pk ?? "id";
	const pkCol = (table as unknown as Record<string, unknown>)[pkName];
	let cachedName = "";

	const adapter: TableAdapter<TTable["$inferSelect"]> = {
		// Field exists for the contract; defineTable doesn't read it. Filled
		// after the first list/find/etc. call resolves drizzle.
		get name() {
			return cachedName;
		},
		pk: pkName,
		async list({ db, scope }) {
			const { eq, getTableName } = loadDrizzleSync();
			if (!cachedName) cachedName = getTableName(table as never);
			if (!scope) {
				return (await execAll(
					db.select().from(table),
				)) as TTable["$inferSelect"][];
			}
			const col = (table as unknown as Record<string, unknown>)[scope.column];
			return (await execAll(
				db.select().from(table).where(eq(col as any, scope.value)),
			)) as TTable["$inferSelect"][];
		},
		async find({ db, rowId }) {
			const { eq, getTableName } = loadDrizzleSync();
			if (!cachedName) cachedName = getTableName(table as never);
			const rows = await execAll(
				db.select().from(table).where(eq(pkCol as any, rowId)),
			);
			return (rows[0] ?? null) as TTable["$inferSelect"] | null;
		},
		async insert({ db, rowId, payload }) {
			const { getTableName } = loadDrizzleSync();
			if (!cachedName) cachedName = getTableName(table as never);
			const values = { ...payload, [pkName]: rowId };
			if (Object.keys(payload).length > 0) {
				await Promise.resolve(
					db
						.insert(table)
						.values(values)
						.onConflictDoUpdate({ target: pkCol, set: payload }),
				);
			} else {
				// All fields stripped (e.g. policy.fields all server-only). Insert
				// id-only row; rely on column defaults.
				await Promise.resolve(
					db.insert(table).values(values).onConflictDoNothing(),
				);
			}
		},
		async update({ db, rowId, payload }) {
			const { eq, getTableName } = loadDrizzleSync();
			if (!cachedName) cachedName = getTableName(table as never);
			await Promise.resolve(
				db.update(table).set(payload).where(eq(pkCol as any, rowId)),
			);
		},
		async delete({ db, rowId }) {
			const { eq, getTableName } = loadDrizzleSync();
			if (!cachedName) cachedName = getTableName(table as never);
			await Promise.resolve(
				db.delete(table).where(eq(pkCol as any, rowId)),
			);
		},
	};
	return adapter;
}

// Preserve the original `drizzleTable` query path: returns a drizzle query
// builder (with `.all()/.get()/then`) rather than a plain Promise<rows[]>.
// Existing call sites destructure `.all()` directly — switching to the
// adapter's plain-Promise list would break them.
function drizzleQueryFn<
	TTable extends DrizzleTableLike,
	TAuth extends AuthContext,
	TParams extends Record<string, unknown>,
>(
	table: TTable,
	opts: DrizzleTableOpts<TTable, TAuth, TParams>,
): (ctx: Ctx<TAuth, TParams>, db: any) => unknown {
	if (opts.query) return opts.query;
	return (ctx, db) => {
		const where = buildDrizzleScopeWhere(opts.scope, ctx, table);
		return where
			? db.select().from(table).where(where)
			: db.select().from(table);
	};
}

function buildDrizzleScopeWhere<
	TTable extends DrizzleTableLike,
	TAuth extends AuthContext,
	TParams extends Record<string, unknown>,
>(
	scope:
		| DrizzleScopeOpt<keyof TTable["$inferSelect"] & string, TAuth, TParams>
		| undefined,
	ctx: Ctx<TAuth, TParams>,
	table: TTable,
): SQL | undefined {
	if (!scope) return undefined;
	if (typeof scope === "function")
		return (scope as DrizzleScopeFn<TAuth, TParams>)(ctx);
	const { eq } = loadDrizzleSync();
	if (typeof scope === "string") {
		const col = (table as unknown as Record<string, unknown>)[scope as string];
		const val = (ctx.params as Record<string, unknown>)[scope as string];
		if (val === undefined) {
			throw new Error(`params.${String(scope)} required for scoped query`);
		}
		return eq(col as any, val);
	}
	const col = (table as unknown as Record<string, unknown>)[scope.column as string];
	const val = (ctx.auth as Record<string, unknown>)[scope.auth as string];
	if (val === undefined) {
		throw new Error(`auth.${String(scope.auth)} required for scoped query`);
	}
	return eq(col as any, val);
}

export function drizzleTable<
	TTable extends DrizzleTableLike,
	TAuth extends AuthContext = AuthContext,
	TParams extends Record<string, unknown> = Record<string, unknown>,
>(
	table: TTable,
	opts: DrizzleTableOpts<TTable, TAuth, TParams> = {},
): {
	query: (ctx: Ctx<TAuth, TParams>, db: any) => unknown;
	mutate: (op: ResolvedOp, ctx: MutationContext<TAuth>, db: any) => Promise<void>;
	authorize: (
		action: AuthorizeAction,
		ctx: MutationContext<TAuth>,
		db: any,
	) => Promise<void>;
} {
	const adapter = drizzleAdapter(table, opts.pk as string | undefined);
	const query = drizzleQueryFn(table, opts);
	// The generic factory's scope option is typed `unknown` for function form,
	// but drizzle's `SQL` is structurally compatible. Cast the opts shape
	// rather than re-typing the factory.
	return defineTable<TTable["$inferSelect"], TAuth, TParams>(
		adapter,
		{
			...(opts as DefineTableOpts<TTable["$inferSelect"], TAuth, TParams>),
			query,
		},
	);
}

// ── tx atomic adapter (drizzle dialect) ────────────────────────────────

/**
 * `TxAtomicAdapter` for drizzle handles. Uses raw SQL via `db.run(sql\`BEGIN\`)`
 * — drizzle's async `db.transaction(...)` is unsafe on the bun-sqlite dialect
 * (sync transaction commits before the async body finishes), so we route
 * through `db.run(...)` which is portable across sqlite and postgres adapters.
 *
 * Exported so users can pass it explicitly to `tx({ atomic: drizzleTxAtomic })`
 * or to `ServerConfig.txAtomic` — and so the server's lazy-loaded fallback
 * has a single source of truth.
 */
export const drizzleTxAtomic: TxAtomicAdapter = {
	async begin(db) {
		const { sql } = loadDrizzleSync();
		const handle = db as { run?: (q: unknown) => unknown };
		if (typeof handle?.run !== "function") {
			throw new Error(
				"drizzleTxAtomic.begin requires a drizzle db with a run() method",
			);
		}
		await Promise.resolve(handle.run(sql`BEGIN`));
	},
	async commit(db) {
		const { sql } = loadDrizzleSync();
		const handle = db as { run?: (q: unknown) => unknown };
		if (typeof handle?.run !== "function") {
			throw new Error(
				"drizzleTxAtomic.commit requires a drizzle db with a run() method",
			);
		}
		await Promise.resolve(handle.run(sql`COMMIT`));
	},
	async rollback(db) {
		const { sql } = loadDrizzleSync();
		const handle = db as { run?: (q: unknown) => unknown };
		if (typeof handle?.run !== "function") {
			throw new Error(
				"drizzleTxAtomic.rollback requires a drizzle db with a run() method",
			);
		}
		await Promise.resolve(handle.run(sql`ROLLBACK`));
	},
};
