import type { ClientOp, ErrorReason } from "../core/types.ts";
import { MAX_CLOCK_DRIFT_MS } from "../core/types.ts";
import { unpackHlc } from "../core/hlc.ts";
import type { QueryOptions } from "./types.ts";

export interface EnforcementResult {
	ok: boolean;
	reason?: ErrorReason;
	op?: ClientOp;
}

export interface EnforcementContext {
	userId: string;
	nodeId: string;
}

export function enforceClockDrift(hlc: string): EnforcementResult {
	let parsed;
	try {
		parsed = unpackHlc(hlc);
	} catch {
		return { ok: false, reason: "clock_drift" };
	}
	const drift = parsed.ms - Date.now();
	if (drift > MAX_CLOCK_DRIFT_MS) {
		return { ok: false, reason: "clock_drift" };
	}
	return { ok: true };
}

export function enforceIdentity(op: ClientOp, _ctx: EnforcementContext): ClientOp {
	return {
		...op,
	};
}

export function enforceReadonly(op: ClientOp, options: QueryOptions): ClientOp {
	// Readonly fields can be set on insert but not changed on update.
	// Combine with serverSet to fully control a field server-side.
	if (op.op === "delete" || op.op === "insert" || !op.payload || !options.readonly?.length) {
		return op;
	}

	const cleaned = { ...op.payload };
	for (const field of options.readonly) {
		delete cleaned[field];
	}

	return { ...op, payload: cleaned };
}

export function enforceServerSet(op: ClientOp, options: QueryOptions): ClientOp {
	if (op.op === "delete" || !options.serverSet) {
		return op;
	}

	const payload = { ...op.payload, ...options.serverSet };
	return { ...op, payload };
}

export function enforceBatchSize(
	batchSize: number | undefined,
	maxBatchSize: number,
): EnforcementResult {
	if (batchSize !== undefined && batchSize > maxBatchSize) {
		return { ok: false, reason: "batch_too_large" };
	}
	return { ok: true };
}

export interface RateLimiter {
	check(userId: string, clientId: string, table?: string): EnforcementResult;
	record(userId: string, clientId: string, table?: string): void;
}

export function createRateLimiter(config: {
	opsPerSecond?: number;
	opsPerMinute?: number;
	perTable?: Record<string, { opsPerSecond?: number; opsPerMinute?: number }>;
}): RateLimiter {
	const secondBuckets = new Map<string, { count: number; resetAt: number }>();
	const minuteBuckets = new Map<string, { count: number; resetAt: number }>();

	function globalKey(userId: string, clientId: string): string {
		return `${userId}:${clientId}`;
	}
	function tableKey(userId: string, clientId: string, table: string): string {
		return `${userId}:${clientId}:${table}`;
	}

	let lastCleanup = Date.now();

	function cleanupStale(now: number): void {
		// Periodically remove expired buckets (every 60s)
		if (now - lastCleanup < 60_000) return;
		lastCleanup = now;

		for (const [k, bucket] of secondBuckets) {
			if (now >= bucket.resetAt) secondBuckets.delete(k);
		}
		for (const [k, bucket] of minuteBuckets) {
			if (now >= bucket.resetAt) minuteBuckets.delete(k);
		}
	}

	function checkBucket(
		buckets: Map<string, { count: number; resetAt: number }>,
		k: string,
		limit: number | undefined,
		now: number,
	): boolean {
		if (!limit) return true;
		const bucket = buckets.get(k);
		return !(bucket && now < bucket.resetAt && bucket.count >= limit);
	}

	function recordBucket(
		buckets: Map<string, { count: number; resetAt: number }>,
		k: string,
		limit: number | undefined,
		windowMs: number,
		now: number,
	): void {
		if (!limit) return;
		const bucket = buckets.get(k);
		if (!bucket || now >= bucket.resetAt) {
			buckets.set(k, { count: 1, resetAt: now + windowMs });
		} else {
			bucket.count++;
		}
	}

	return {
		check(userId: string, clientId: string, table?: string): EnforcementResult {
			const now = Date.now();
			// Run cleanup from check too so a limiter that only ever rejects
			// (no record calls) still trims expired buckets.
			cleanupStale(now);
			const gk = globalKey(userId, clientId);

			if (!checkBucket(secondBuckets, gk, config.opsPerSecond, now)) {
				return { ok: false, reason: "rate_limited" };
			}
			if (!checkBucket(minuteBuckets, gk, config.opsPerMinute, now)) {
				return { ok: false, reason: "rate_limited" };
			}

			const tableCfg = table ? config.perTable?.[table] : undefined;
			if (tableCfg && table) {
				const tk = tableKey(userId, clientId, table);
				if (!checkBucket(secondBuckets, tk, tableCfg.opsPerSecond, now)) {
					return { ok: false, reason: "rate_limited" };
				}
				if (!checkBucket(minuteBuckets, tk, tableCfg.opsPerMinute, now)) {
					return { ok: false, reason: "rate_limited" };
				}
			}

			return { ok: true };
		},

		record(userId: string, clientId: string, table?: string): void {
			const now = Date.now();
			const gk = globalKey(userId, clientId);

			recordBucket(secondBuckets, gk, config.opsPerSecond, 1000, now);
			recordBucket(minuteBuckets, gk, config.opsPerMinute, 60_000, now);

			const tableCfg = table ? config.perTable?.[table] : undefined;
			if (tableCfg && table) {
				const tk = tableKey(userId, clientId, table);
				recordBucket(secondBuckets, tk, tableCfg.opsPerSecond, 1000, now);
				recordBucket(minuteBuckets, tk, tableCfg.opsPerMinute, 60_000, now);
			}

			cleanupStale(now);
		},
	};
}
