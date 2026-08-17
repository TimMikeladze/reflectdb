import type { ConflictPolicy } from "./types.ts";

// ── Row type source (drizzle table OR plain phantom type) ───────────────

export interface DrizzleTableLike {
	$inferSelect: Record<string, unknown>;
	$inferInsert: Record<string, unknown>;
}

// ── ServerSet schema-side declaration ───────────────────────────────────

/**
 * Value supplied per serverSet field in the schema's object form.
 * Either a static value or a function that receives the request context.
 */
export type ServerSetSchemaValue =
	| unknown
	| ((ctx: { auth: unknown; params: unknown }) => unknown);

/**
 * Schema-side `serverSet` declaration. Two shapes:
 *  - `string[]` — keys only; values are supplied at `implement(...)` time.
 *  - `Record<string, ServerSetSchemaValue>` — keys + values collocated in schema.
 */
export type SchemaServerSet =
	| readonly string[]
	| Readonly<Record<string, ServerSetSchemaValue>>;

// ── Query definition ────────────────────────────────────────────────────

export interface SyncQueryDef {
	/** Drizzle table — row type derived from $inferSelect */
	table?: DrizzleTableLike;
	/** Phantom row type for non-drizzle usage: `{} as MyRow` */
	row?: Record<string, unknown>;
	/** Database tables for change detection. Falls back to query key name. */
	tables?: string[];
	/** Phantom value for params type: `{} as { orgId: string }` */
	params?: Record<string, unknown>;
	/** Primary key column name. Defaults to "id". Single-column only. */
	pk?: string;
	conflict?: ConflictPolicy;
	readonly?: readonly string[];
	serverSet?: SchemaServerSet;
	countHints?: boolean;
}

// ── View definition (read-only computed query) ─────────────────────────

/**
 * Read-only computed query. Compiles down to `server.query(...)` with a
 * throwing mutate so the type system blocks `useSync(...).insert/update/remove`
 * and the runtime rejects any direct write attempt.
 */
export interface SyncViewDef {
	__view: true;
	row?: Record<string, unknown>;
	params?: Record<string, unknown>;
	tables?: string[];
	/** Tables to watch for change-detection. Defaults to `tables` or query key. */
	deps?: string[];
}

export function view<
	TRow extends object,
	TParams extends Record<string, unknown> | undefined = undefined,
>(opts: {
	row?: TRow;
	params?: TParams;
	deps?: string[];
	tables?: string[];
}): SyncViewDef & { row?: TRow; params?: TParams } {
	return { __view: true, ...opts } as never;
}

// ── Presence definition (typed ephemeral) ──────────────────────────────

/**
 * Typed ephemeral channel. Sugar over the runtime `useEphemeral` hook —
 * derives a stable key from the schema name + serialized params and gives
 * `peers`/`set` a typed `state`.
 */
export interface SyncPresenceDef {
	__presence: true;
	state?: Record<string, unknown>;
	params?: Record<string, unknown>;
	ttlMs?: number;
}

export function presence<
	TState extends object,
	TParams extends Record<string, unknown> | undefined = undefined,
>(opts: {
	state?: TState;
	params?: TParams;
	ttlMs?: number;
}): SyncPresenceDef & { state?: TState; params?: TParams } {
	return { __presence: true, ...opts } as never;
}

// ── Schema entry union ─────────────────────────────────────────────────

export type SyncQueryEntry = SyncQueryDef | SyncViewDef | SyncPresenceDef;
export type SyncQueryMap = Record<string, SyncQueryEntry>;

// ── Column-level type validation ───────────────────────────────────────

/** Extract column names from a query definition's table or row type */
type ColumnOf<TDef> = TDef extends { table: DrizzleTableLike }
	? keyof TDef["table"]["$inferSelect"] & string
	: TDef extends { row: infer R extends Record<string, unknown> }
		? keyof R & string
		: string;

/** Constrain serverSet and readonly to valid column names. Accepts either array or object form for serverSet. View/presence entries don't have these fields, so the constraint is empty. */
type FieldsConstraint<TDef> = TDef extends { __view: true } | { __presence: true }
	? Record<string, never>
	: {
			serverSet?:
				| readonly ColumnOf<TDef>[]
				| Readonly<Partial<Record<ColumnOf<TDef>, ServerSetSchemaValue>>>;
			readonly?: readonly ColumnOf<TDef>[];
		};

// ── Define queries (identity fn, preserves literal types via `const T`) ─

export function defineSyncQueries<const T extends SyncQueryMap>(
	queries: T & { [K in keyof T]: FieldsConstraint<T[K]> },
): T {
	return queries;
}

/** Phantom type helper — passes a type without needing a real value or `as` cast */
export function t<T>(): T {
	return undefined as T;
}

// ── Type utilities ──────────────────────────────────────────────────────

/** Row type: from `table.$inferSelect` if drizzle, otherwise from `row` phantom */
export type InferRow<
	TQueries extends SyncQueryMap,
	K extends keyof TQueries,
> = TQueries[K] extends { table: DrizzleTableLike }
	? TQueries[K]["table"]["$inferSelect"]
	: TQueries[K] extends { row: infer R extends Record<string, unknown> }
		? R
		: Record<string, unknown>;

/** Presence state type — typed shape passed to/received from `usePresence`. */
export type InferState<
	TQueries extends SyncQueryMap,
	K extends keyof TQueries,
> = TQueries[K] extends { state: infer S extends Record<string, unknown> }
	? S
	: Record<string, unknown>;

/** Params type. `undefined` when no params declared. */
export type InferParams<
	TQueries extends SyncQueryMap,
	K extends keyof TQueries,
> = TQueries[K] extends { params: infer P extends Record<string, unknown> } ? P : undefined;

/** `true` when the query declares params */
export type RequiresParams<
	TQueries extends SyncQueryMap,
	K extends keyof TQueries,
> = TQueries[K] extends { params: Record<string, unknown> } ? true : false;

/** Primary key column name. Defaults to "id". */
export type PkOf<TDef> = TDef extends { pk: infer P extends string } ? P : "id";

/** Extract serverSet field names from either array form or object form. */
export type InferServerSetKeys<TDef> = TDef extends {
	serverSet: readonly (infer S extends string)[];
}
	? S
	: TDef extends { serverSet: infer O extends Readonly<Record<string, unknown>> }
		? keyof O & string
		: never;

/**
 * Row minus readonly fields, serverSet fields, and the primary key.
 * View defs collapse to `never` to block client-side writes at the type level.
 * Presence defs aren't writable rows; they collapse to `never` too.
 */
export type InferWritableRow<TQueries extends SyncQueryMap, K extends keyof TQueries> =
	TQueries[K] extends { __view: true } | { __presence: true }
		? never
		: Omit<
				InferRow<TQueries, K>,
				| (TQueries[K] extends { readonly: readonly (infer R extends string)[] } ? R : never)
				| InferServerSetKeys<TQueries[K]>
				| PkOf<TQueries[K]>
			>;
