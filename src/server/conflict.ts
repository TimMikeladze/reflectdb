import { compareHlc } from "../core/hlc.ts";
import { MutationError } from "../core/types.ts";
import type { ConflictPolicy, ConflictResolver, OpType } from "../core/types.ts";

export interface ConflictInput {
	op: OpType;
	payload: Record<string, unknown> | null;
	hlc: string;
	rowId: string;
	tableName: string;
	userId: string;
}

export interface ExistingRow {
	row: Record<string, unknown> | null;
	rowHlc: string | null;
	colClocks: Record<string, string>;
}

export interface ConflictResult {
	accepted: boolean;
	resolvedRow: Record<string, unknown> | null;
	updatedColClocks: Record<string, string>;
	reason?: string;
}

export function resolveConflict(
	policy: ConflictPolicy,
	incoming: ConflictInput,
	existing: ExistingRow,
): ConflictResult {
	if (typeof policy === "object" && policy.policy === "custom") {
		return resolveCustom(policy.resolve, incoming, existing);
	}

	switch (policy) {
		case "lww":
			return resolveLww(incoming, existing);
		case "merge":
			return resolveMerge(incoming, existing);
		case "server":
			return resolveServer(incoming, existing);
		default:
			return resolveLww(incoming, existing);
	}
}

function resolveLww(incoming: ConflictInput, existing: ExistingRow): ConflictResult {
	// No existing row — accept unconditionally
	if (!existing.row || !existing.rowHlc) {
		return {
			accepted: true,
			resolvedRow: incoming.op === "delete" ? null : incoming.payload,
			updatedColClocks: buildColClocks(incoming),
		};
	}

	// Compare incoming HLC against the row's last HLC
	if (compareHlc(incoming.hlc, existing.rowHlc) > 0) {
		if (incoming.op === "delete") {
			return {
				accepted: true,
				resolvedRow: null,
				updatedColClocks: { ...existing.colClocks, _row: incoming.hlc },
			};
		}
		// Merge existing row with incoming payload for partial updates
		const resolvedRow =
			incoming.op === "update" ? { ...existing.row, ...incoming.payload } : incoming.payload;
		// Preserve existing per-column clocks; overwrite only the touched cols
		// + _row. buildColClocks alone would drop clocks for unchanged cols,
		// breaking later policy switches (lww→merge) or per-column inspection.
		const clocks: Record<string, string> = { ...existing.colClocks, _row: incoming.hlc };
		if (incoming.payload) {
			for (const col of Object.keys(incoming.payload)) {
				clocks[col] = incoming.hlc;
			}
		}
		// Insert with existing row should still anchor all incoming cols
		if (incoming.op === "insert" && incoming.payload) {
			for (const col of Object.keys(incoming.payload)) {
				clocks[col] = incoming.hlc;
			}
		}
		return {
			accepted: true,
			resolvedRow,
			updatedColClocks: clocks,
		};
	}

	// Incoming HLC is older — reject
	return {
		accepted: false,
		resolvedRow: existing.row,
		updatedColClocks: existing.colClocks,
	};
}

function resolveMerge(incoming: ConflictInput, existing: ExistingRow): ConflictResult {
	// No existing row — accept unconditionally
	if (!existing.row || !existing.rowHlc) {
		return {
			accepted: true,
			resolvedRow: incoming.op === "delete" ? null : incoming.payload,
			updatedColClocks: buildColClocks(incoming),
		};
	}

	if (incoming.op === "delete") {
		// Delete uses row-level HLC comparison (same as LWW)
		if (compareHlc(incoming.hlc, existing.rowHlc) > 0) {
			return {
				accepted: true,
				resolvedRow: null,
				updatedColClocks: { ...existing.colClocks, _row: incoming.hlc },
			};
		}
		return {
			accepted: false,
			resolvedRow: existing.row,
			updatedColClocks: existing.colClocks,
			reason: "merge_stale",
		};
	}

	// For update/insert — merge per column
	const payload = incoming.payload ?? {};
	const merged = { ...existing.row };
	const clocks = { ...existing.colClocks };
	let anyAccepted = false;

	for (const [col, value] of Object.entries(payload)) {
		const existingClock = clocks[col];
		if (!existingClock || compareHlc(incoming.hlc, existingClock) > 0) {
			merged[col] = value;
			clocks[col] = incoming.hlc;
			anyAccepted = true;
		}
	}

	// Update the row-level HLC if any column was accepted
	if (anyAccepted && (!clocks["_row"] || compareHlc(incoming.hlc, clocks["_row"]!) > 0)) {
		clocks["_row"] = incoming.hlc;
	}

	if (!anyAccepted) {
		// All columns lost vs existing per-column HLCs. Server already has
		// equal-or-newer values — no divergence. Distinct reason so clients
		// can mark the op resolved (not retry as generic server_error).
		return {
			accepted: false,
			resolvedRow: existing.row,
			updatedColClocks: existing.colClocks,
			reason: "merge_stale",
		};
	}

	return {
		accepted: true,
		resolvedRow: merged,
		updatedColClocks: clocks,
	};
}

function resolveServer(incoming: ConflictInput, existing: ExistingRow): ConflictResult {
	// No existing row — first write wins
	if (!existing.row) {
		return {
			accepted: true,
			resolvedRow: incoming.op === "delete" ? null : incoming.payload,
			updatedColClocks: buildColClocks(incoming),
		};
	}

	// Row exists — reject
	return {
		accepted: false,
		resolvedRow: existing.row,
		updatedColClocks: existing.colClocks,
		reason: "server_conflict",
	};
}

function resolveCustom(
	resolve: ConflictResolver,
	incoming: ConflictInput,
	existing: ExistingRow,
): ConflictResult {
	// No existing row — accept unconditionally
	if (!existing.row) {
		return {
			accepted: true,
			resolvedRow: incoming.op === "delete" ? null : incoming.payload,
			updatedColClocks: buildColClocks(incoming),
		};
	}

	let result: ReturnType<ConflictResolver>;
	try {
		result = resolve(
			{ op: incoming.op, payload: incoming.payload, hlc: incoming.hlc },
			{ row: existing.row, colClocks: existing.colClocks },
			{
				table: incoming.tableName,
				rowId: incoming.rowId,
				userId: incoming.userId,
			},
		);
	} catch (err) {
		// MutationError is the only "intentional reject" channel — pass its
		// reason through verbatim (e.g. throw new MutationError("custom_conflict")).
		// Anything else is an unexpected bug or transient infra failure: log and
		// surface as server_error so apps can distinguish from policy rejection.
		if (err instanceof MutationError) {
			return {
				accepted: false,
				resolvedRow: existing.row,
				updatedColClocks: existing.colClocks,
				reason: err.reason,
			};
		}
		console.error(
			`[reflectdb] Custom conflict resolver threw for ${incoming.tableName}/${incoming.rowId}:`,
			err,
		);
		return {
			accepted: false,
			resolvedRow: existing.row,
			updatedColClocks: existing.colClocks,
			reason: "server_error",
		};
	}

	// Determine which columns changed
	const clocks = { ...existing.colClocks };
	let anyChanged = false;
	for (const [col, value] of Object.entries(result.row)) {
		if (existing.row[col] !== value) {
			clocks[col] = incoming.hlc;
			anyChanged = true;
		}
	}
	// Only advance _row when at least one column changed. Bumping _row on a
	// no-op resolution would create a phantom "newer" row that misleads resume
	// watermarks and compaction.
	if (anyChanged) {
		clocks["_row"] = incoming.hlc;
	}

	return {
		accepted: true,
		resolvedRow: result.row,
		updatedColClocks: clocks,
	};
}

function buildColClocks(incoming: ConflictInput): Record<string, string> {
	const clocks: Record<string, string> = { _row: incoming.hlc };
	if (incoming.payload) {
		for (const col of Object.keys(incoming.payload)) {
			clocks[col] = incoming.hlc;
		}
	}
	return clocks;
}
