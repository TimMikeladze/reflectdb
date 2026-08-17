import type { AuthContext } from "../core/types.ts";
import type { AuthorizeAction, MutationContext, ResolvedOp } from "./types.ts";

// ── Public option types ─────────────────────────────────────────────────

type Ctx<TAuth extends AuthContext, TParams extends Record<string, unknown>> = {
	auth: TAuth;
	params: TParams;
};

/**
 * Function-form scope returns an adapter-interpreted SQL fragment (e.g. a
 * drizzle `SQL`, a kysely `Expression<boolean>`, or a raw string). The generic
 * factory treats it as opaque (`unknown`) — ORM-specific helpers like
 * `drizzleTable` narrow the return type at their call site.
 */
type ScopeFn<TAuth extends AuthContext, TParams extends Record<string, unknown>> = (
	ctx: Ctx<TAuth, TParams>,
) => unknown;

type ScopeOpt<
	TRowKey extends string,
	TAuth extends AuthContext,
	TParams extends Record<string, unknown>,
> =
	| TRowKey
	| { auth: keyof TAuth & string; column: TRowKey }
	| ScopeFn<TAuth, TParams>;

type StampSource<TAuth extends AuthContext, TParams extends Record<string, unknown>> =
	| "auth.userId"
	| "auth.name"
	| string
	| ((ctx: Ctx<TAuth, TParams>) => unknown);

type ServerSetSource<TAuth extends AuthContext, TParams extends Record<string, unknown>> =
	| unknown
	| ((ctx: Ctx<TAuth, TParams>) => unknown);

type FieldPolicy<TAuth extends AuthContext, TParams extends Record<string, unknown>> =
	| "server-only"
	| "insert-only"
	| {
			write: (input: {
				ctx: Ctx<TAuth, TParams>;
				existing?: Record<string, unknown> | null;
				payload: Record<string, unknown>;
			}) => boolean | Promise<boolean>;
	  };

// ── Adapter contract ────────────────────────────────────────────────────

/**
 * Built-in scope shorthand resolves to one of these. Function-form scope
 * (returning raw SQL) bypasses the adapter — it must be paired with an
 * `opts.query` override since the adapter has no SQL fragment to consume.
 */
export interface ScopeFilter {
	kind: "params" | "auth";
	column: string;
	value: unknown;
}

/**
 * Minimal contract a data layer must implement to plug into `defineTable`.
 * Per-row I/O only — bulk paths intentionally absent so adapters stay short.
 */
export interface TableAdapter<TRow extends Record<string, unknown> = Record<string, unknown>> {
	/** Logical table name — used for op log + change detection. */
	name: string;
	/** Primary key column. Default "id". */
	pk?: string;
	/**
	 * Fetch rows, optionally narrowed by a scope filter the factory passes
	 * for built-in scope shorthand. Implement using the adapter's native
	 * query builder. Return rows or a thenable resolving to rows.
	 */
	list(input: { db: any; scope?: ScopeFilter }): Promise<TRow[]> | TRow[];
	/** Fetch a single row by pk. Return null if absent. */
	find(input: { db: any; rowId: string }): Promise<TRow | null> | TRow | null;
	/** Insert (or upsert) a row. payload does NOT include the pk; rowId is authoritative. */
	insert(input: {
		db: any;
		rowId: string;
		payload: Record<string, unknown>;
	}): Promise<void> | void;
	/** Update an existing row. payload may be partial. */
	update(input: {
		db: any;
		rowId: string;
		payload: Record<string, unknown>;
	}): Promise<void> | void;
	/** Delete a row by pk. */
	delete(input: { db: any; rowId: string }): Promise<void> | void;
}

// ── Generic options ─────────────────────────────────────────────────────

export interface DefineTableOpts<
	TRow extends Record<string, unknown> = Record<string, unknown>,
	TAuth extends AuthContext = AuthContext,
	TParams extends Record<string, unknown> = Record<string, unknown>,
> {
	scope?: ScopeOpt<keyof TRow & string, TAuth, TParams>;
	rowId?: string;
	ownerStamp?: Partial<Record<keyof TRow & string, StampSource<TAuth, TParams>>>;
	serverSet?: Partial<Record<keyof TRow & string, ServerSetSource<TAuth, TParams>>>;
	policy?: {
		read?: (input: {
			ctx: Ctx<TAuth, TParams>;
			existing?: Record<string, unknown> | null;
		}) => boolean | Promise<boolean>;
		insert?: (input: {
			ctx: Ctx<TAuth, TParams>;
			payload: Record<string, unknown>;
		}) => boolean | Promise<boolean>;
		update?: (input: {
			ctx: Ctx<TAuth, TParams>;
			existing: Record<string, unknown>;
			payload: Record<string, unknown>;
		}) => boolean | Promise<boolean>;
		delete?: (input: {
			ctx: Ctx<TAuth, TParams>;
			existing: Record<string, unknown>;
		}) => boolean | Promise<boolean>;
		fields?: Partial<Record<keyof TRow & string, FieldPolicy<TAuth, TParams>>>;
	};
	hooks?: {
		beforeInsert?: (input: {
			payload: Record<string, unknown>;
			ctx: Ctx<TAuth, TParams>;
			db: any;
		}) => Promise<void> | void;
		afterInsert?: (input: {
			row: Record<string, unknown>;
			ctx: Ctx<TAuth, TParams>;
			db: any;
		}) => Promise<void> | void;
		beforeUpdate?: (input: {
			payload: Record<string, unknown>;
			existing: Record<string, unknown>;
			ctx: Ctx<TAuth, TParams>;
			db: any;
		}) => Promise<void> | void;
		afterUpdate?: (input: {
			row: Record<string, unknown>;
			previous: Record<string, unknown>;
			ctx: Ctx<TAuth, TParams>;
			db: any;
		}) => Promise<void> | void;
		beforeDelete?: (input: {
			existing: Record<string, unknown>;
			ctx: Ctx<TAuth, TParams>;
			db: any;
		}) => Promise<void> | void;
		afterDelete?: (input: {
			rowId: string;
			ctx: Ctx<TAuth, TParams>;
			db: any;
		}) => Promise<void> | void;
	};
	query?: (ctx: Ctx<TAuth, TParams>, db: any) => unknown;
	insert?: (input: {
		payload: Record<string, unknown>;
		existing?: Record<string, unknown> | null;
		ctx: Ctx<TAuth, TParams>;
		db: any;
	}) => Promise<void> | void;
	update?: (input: {
		payload: Record<string, unknown>;
		existing: Record<string, unknown>;
		ctx: Ctx<TAuth, TParams>;
		db: any;
	}) => Promise<void> | void;
	delete?: (input: {
		rowId: string;
		existing: Record<string, unknown> | null;
		ctx: Ctx<TAuth, TParams>;
		db: any;
	}) => Promise<void> | void;
	pk?: keyof TRow & string;
}

// ── Internal helpers (adapter-agnostic) ─────────────────────────────────

function getByDottedPath(
	root: Record<string, unknown>,
	path: string,
): unknown {
	const parts = path.split(".");
	let cur: unknown = root;
	for (const p of parts) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[p];
	}
	return cur;
}

function renderTemplate(
	template: string,
	ctx: { auth: Record<string, unknown>; params: Record<string, unknown> },
): string {
	return template.replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
		const trimmed = expr.trim();
		// Bare names (no dot) resolve from params.
		const path = trimmed.includes(".") ? trimmed : `params.${trimmed}`;
		const v = getByDottedPath(ctx as Record<string, unknown>, path);
		return v == null ? "" : String(v);
	});
}

function resolveStamp<TAuth extends AuthContext, TParams extends Record<string, unknown>>(
	source: StampSource<TAuth, TParams>,
	ctx: Ctx<TAuth, TParams>,
): unknown {
	if (typeof source === "function") return source(ctx);
	if (source === "auth.userId") return ctx.auth.userId;
	if (source === "auth.name") return (ctx.auth as Record<string, unknown>).name;
	if (typeof source === "string" && source.includes(".")) {
		return getByDottedPath(ctx as unknown as Record<string, unknown>, source);
	}
	return source;
}

function buildScopeFilter<
	TRowKey extends string,
	TAuth extends AuthContext,
	TParams extends Record<string, unknown>,
>(
	scope: ScopeOpt<TRowKey, TAuth, TParams> | undefined,
	ctx: Ctx<TAuth, TParams>,
): ScopeFilter | undefined {
	if (!scope) return undefined;
	if (typeof scope === "function") return undefined; // function form must be paired with opts.query
	if (typeof scope === "string") {
		const val = (ctx.params as Record<string, unknown>)[scope];
		if (val === undefined) {
			throw new Error(`params.${scope} required for scoped query`);
		}
		return { kind: "params", column: scope, value: val };
	}
	const { auth: authKey, column } = scope;
	const val = (ctx.auth as Record<string, unknown>)[authKey];
	// Refuse when auth field is missing — silently emitting `WHERE col = undefined`
	// produces no rows but also no error, masking a misconfigured scope.
	if (val === undefined) {
		throw new Error(`auth.${authKey} required for scoped query`);
	}
	return { kind: "auth", column, value: val };
}

// ── Generic factory ─────────────────────────────────────────────────────

export function defineTable<
	TRow extends Record<string, unknown> = Record<string, unknown>,
	TAuth extends AuthContext = AuthContext,
	TParams extends Record<string, unknown> = Record<string, unknown>,
>(
	adapter: TableAdapter<TRow>,
	opts: DefineTableOpts<TRow, TAuth, TParams> = {},
): {
	query: (ctx: Ctx<TAuth, TParams>, db: any) => unknown;
	mutate: (op: ResolvedOp, ctx: MutationContext<TAuth>, db: any) => Promise<void>;
	authorize: (
		action: AuthorizeAction,
		ctx: MutationContext<TAuth>,
		db: any,
	) => Promise<void>;
} {
	const pkName = (opts.pk ?? adapter.pk ?? "id") as string;

	const query = opts.query
		? opts.query
		: (ctx: Ctx<TAuth, TParams>, db: any) => {
				if (typeof opts.scope === "function") {
					// Function-form scope returns an adapter-specific fragment the
					// generic adapter has no contract to consume. Force the user
					// to pair it with `opts.query`.
					throw new Error(
						"function-form scope requires opts.query override on defineTable (no SQL fragment to pass to adapter)",
					);
				}
				const scope = buildScopeFilter(opts.scope, ctx);
				return adapter.list({ db, scope });
			};

	const authorize = async (
		action: AuthorizeAction,
		ctx: MutationContext<TAuth>,
		_db: any,
	) => {
		if (action.type === "read" && opts.policy?.read) {
			const ok = await opts.policy.read({ ctx: ctx as Ctx<TAuth, TParams> });
			if (!ok) throw new Error("policy denied read");
		}
		// Write-side policy runs inside mutate; avoid double-invocation here.
	};

	const mutate = async (
		op: ResolvedOp,
		rawCtx: MutationContext<TAuth>,
		db: any,
	): Promise<void> => {
		const ctx = rawCtx as Ctx<TAuth, TParams>;

		// op.rowId is authoritative; drop any client-supplied pk to defeat id-tampering.
		const payload: Record<string, unknown> =
			op.payload ? { ...op.payload } : {};
		if (op.type !== "delete") delete payload[pkName];

		// rowId template: enforce derived row identity (e.g. ${gameId}:${auth.userId}).
		if (opts.rowId) {
			const expected = renderTemplate(opts.rowId, {
				auth: ctx.auth as Record<string, unknown>,
				params: ctx.params as Record<string, unknown>,
			});
			if (op.rowId !== expected) {
				throw new Error("rowId mismatch");
			}
		}

		// Scope guard on payload (insert) — must match before we even read existing.
		// Reject undefined explicitly: payload[col] === ctx.params[col] === undefined
		// would otherwise pass the equality check and let an unscoped row through.
		if (opts.scope && typeof opts.scope === "string" && op.type === "insert") {
			const col = opts.scope as string;
			const paramVal = (ctx.params as Record<string, unknown>)[col];
			if (paramVal === undefined) {
				throw new Error(`params.${col} required for scoped mutation`);
			}
			if ((payload as Record<string, unknown>)[col] !== paramVal) {
				throw new Error(`${col} mismatch`);
			}
		}
		if (
			opts.scope &&
			typeof opts.scope === "object" &&
			!Array.isArray(opts.scope) &&
			"auth" in opts.scope &&
			op.type === "insert"
		) {
			const { auth: authKey, column } = opts.scope as {
				auth: string;
				column: string;
			};
			const authVal = (ctx.auth as Record<string, unknown>)[authKey];
			if (authVal === undefined) {
				throw new Error(`auth.${authKey} required for scoped mutation`);
			}
			if ((payload as Record<string, unknown>)[column] !== authVal) {
				throw new Error(`${column} mismatch`);
			}
		}

		// Fetch existing BEFORE policy: policy.update/delete + cross-scope guard need it.
		const existing =
			op.type !== "insert"
				? ((await Promise.resolve(adapter.find({ db, rowId: op.rowId }))) as
						| Record<string, unknown>
						| null)
				: null;

		// Cross-scope edit guard: existing row must already match scope on update/delete.
		if (op.type !== "insert" && existing) {
			if (opts.scope && typeof opts.scope === "string") {
				const col = opts.scope as string;
				const paramVal = (ctx.params as Record<string, unknown>)[col];
				if (paramVal === undefined) {
					throw new Error(`params.${col} required for scoped mutation`);
				}
				if (existing[col] !== paramVal) {
					throw new Error(`${col} mismatch`);
				}
			}
			if (
				opts.scope &&
				typeof opts.scope === "object" &&
				!Array.isArray(opts.scope) &&
				"auth" in opts.scope
			) {
				const { auth: authKey, column } = opts.scope as {
					auth: string;
					column: string;
				};
				const authVal = (ctx.auth as Record<string, unknown>)[authKey];
				if (authVal === undefined) {
					throw new Error(`auth.${authKey} required for scoped mutation`);
				}
				if (existing[column] !== authVal) {
					throw new Error(`${column} mismatch`);
				}
			}
		}

		// Policy gates.
		if (op.type === "insert" && opts.policy?.insert) {
			const ok = await opts.policy.insert({ ctx, payload });
			if (!ok) throw new Error("policy denied insert");
		} else if (op.type === "update" && opts.policy?.update) {
			const ok = await opts.policy.update({
				ctx,
				existing: existing ?? {},
				payload,
			});
			if (!ok) throw new Error("policy denied update");
		} else if (op.type === "delete" && opts.policy?.delete) {
			const ok = await opts.policy.delete({ ctx, existing: existing ?? {} });
			if (!ok) throw new Error("policy denied delete");
		}

		// Field-level policy (write-side enforcement).
		if (opts.policy?.fields && op.type !== "delete") {
			for (const [field, rule] of Object.entries(opts.policy.fields)) {
				if (rule === "server-only") {
					delete payload[field];
				} else if (rule === "insert-only") {
					if (op.type === "update") delete payload[field];
				} else if (typeof rule === "object" && rule && "write" in rule) {
					const allow = await rule.write({
						ctx,
						existing: existing ?? null,
						payload,
					});
					if (!allow) delete payload[field];
				}
			}
		}

		// ownerStamp on insert.
		if (op.type === "insert" && opts.ownerStamp) {
			for (const [field, source] of Object.entries(opts.ownerStamp)) {
				if (source === undefined) continue;
				payload[field] = resolveStamp(
					source as StampSource<TAuth, TParams>,
					ctx,
				);
			}
		}

		// serverSet on insert + update (mirrors today's per-write behavior).
		if (op.type !== "delete" && opts.serverSet) {
			for (const [field, val] of Object.entries(opts.serverSet)) {
				if (val === undefined) continue;
				payload[field] = typeof val === "function"
					? (val as (c: Ctx<TAuth, TParams>) => unknown)(ctx)
					: val;
			}
		}

		// before-hooks.
		if (op.type === "insert") {
			await opts.hooks?.beforeInsert?.({ payload, ctx, db });
		} else if (op.type === "update") {
			await opts.hooks?.beforeUpdate?.({
				payload,
				existing: existing ?? {},
				ctx,
				db,
			});
		} else if (op.type === "delete") {
			await opts.hooks?.beforeDelete?.({ existing: existing ?? {}, ctx, db });
		}

		// Delegate to override or adapter writer.
		if (op.type === "delete") {
			if (opts.delete) {
				await opts.delete({ rowId: op.rowId, existing, ctx, db });
			} else {
				await Promise.resolve(adapter.delete({ db, rowId: op.rowId }));
			}
		} else if (op.type === "insert" && opts.insert) {
			await opts.insert({ payload, existing, ctx, db });
		} else if (op.type === "update" && opts.update) {
			await opts.update({ payload, existing: existing ?? {}, ctx, db });
		} else if (op.type === "update") {
			// Real UPDATE — partial payloads can't satisfy NOT NULL on insert,
			// and an empty stripped payload is a no-op rather than an error.
			if (Object.keys(payload).length > 0) {
				await Promise.resolve(
					adapter.update({ db, rowId: op.rowId, payload }),
				);
			}
		} else {
			// INSERT path — adapter is responsible for upsert semantics so the
			// same op id retrying remains idempotent at-least-once.
			await Promise.resolve(
				adapter.insert({ db, rowId: op.rowId, payload }),
			);
		}

		// after-hooks. Re-select row for accuracy (post-conflict, post-defaults).
		if (op.type === "delete") {
			await opts.hooks?.afterDelete?.({ rowId: op.rowId, ctx, db });
		} else {
			const hookName =
				op.type === "insert" ? "afterInsert" : ("afterUpdate" as const);
			const after = opts.hooks?.[hookName];
			if (after) {
				const row =
					((await Promise.resolve(adapter.find({ db, rowId: op.rowId }))) as
						| Record<string, unknown>
						| null) ?? {};
				if (op.type === "insert") {
					await opts.hooks?.afterInsert?.({ row, ctx, db });
				} else {
					await opts.hooks?.afterUpdate?.({
						row,
						previous: existing ?? {},
						ctx,
						db,
					});
				}
			}
		}
	};

	return { query, mutate, authorize };
}

// ── Internal: shared helpers exported for ORM-specific siblings ─────────

/**
 * @internal — consumed by `./drizzle.ts`
 *
 * Explicitly typed: `isolatedDeclarations` cannot infer a shorthand object
 * literal, and the dts build fails on it (TS9016).
 */
export const __internal: {
	getByDottedPath: typeof getByDottedPath;
	renderTemplate: typeof renderTemplate;
	resolveStamp: typeof resolveStamp;
	buildScopeFilter: typeof buildScopeFilter;
} = {
	getByDottedPath,
	renderTemplate,
	resolveStamp,
	buildScopeFilter,
};
