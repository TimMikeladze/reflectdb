import type { ClientOp, ConflictPolicy, ErrorReason } from "../core/types.ts";
import {
	enforceClockDrift,
	enforceReadonly,
	enforceServerSet,
	enforceBatchSize,
} from "./enforcement.ts";
import type { RateLimiter } from "./enforcement.ts";
import { resolveConflict } from "./conflict.ts";
import type { ExistingRow } from "./conflict.ts";
import type { QueryOptions } from "./types.ts";

export interface PipelineContext {
	userId: string;
	nodeId: string;
	options: QueryOptions;
	conflict: ConflictPolicy;
	rateLimiter?: RateLimiter;
	maxBatchSize?: number;
}

export interface PipelineResult {
	accepted: boolean;
	op: ClientOp;
	resolvedRow: Record<string, unknown> | null;
	updatedColClocks: Record<string, string>;
	reason?: ErrorReason;
}

export function processOp(
	op: ClientOp,
	existing: ExistingRow,
	ctx: PipelineContext,
): PipelineResult {
	// 1. Clock drift
	const drift = enforceClockDrift(op.hlc);
	if (!drift.ok) {
		return reject(op, existing, drift.reason!);
	}

	// 2. Rate limiting
	if (ctx.rateLimiter) {
		try {
			const rate = ctx.rateLimiter.check(ctx.userId, ctx.nodeId, op.table);
			if (!rate.ok) {
				return reject(op, existing, rate.reason!);
			}
			ctx.rateLimiter.record(ctx.userId, ctx.nodeId, op.table);
		} catch (err) {
			// Fail-open: a buggy rate limiter shouldn't crash the pipeline
			console.error("[reflectdb] Rate limiter error (fail-open):", err);
		}
	}

	// 3. Batch size
	if (ctx.maxBatchSize !== undefined) {
		const batch = enforceBatchSize(op.batchSize, ctx.maxBatchSize);
		if (!batch.ok) {
			return reject(op, existing, batch.reason!);
		}
	}

	// 4. Strip readonly fields
	op = enforceReadonly(op, ctx.options);

	// 5. Inject serverSet fields
	op = enforceServerSet(op, ctx.options);

	// 6. Conflict resolution
	const conflict = resolveConflict(
		ctx.conflict,
		{
			op: op.op,
			payload: op.payload,
			hlc: op.hlc,
			rowId: op.rowId,
			tableName: op.table,
			userId: ctx.userId,
		},
		existing,
	);

	return {
		accepted: conflict.accepted,
		op,
		resolvedRow: conflict.resolvedRow,
		updatedColClocks: conflict.updatedColClocks,
		reason: conflict.reason as ErrorReason | undefined,
	};
}

function reject(op: ClientOp, existing: ExistingRow, reason: ErrorReason): PipelineResult {
	return {
		accepted: false,
		op,
		resolvedRow: existing.row,
		updatedColClocks: existing.colClocks,
		reason,
	};
}
