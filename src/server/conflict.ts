import { compareHlc } from "../core/hlc.ts";
import {
	applyHunks,
	hashText,
	merge3,
	TEXT_EDIT_KEY,
	TEXT_SEEN_COLUMN,
	TEXT_SEEN_LIMIT,
	type TextEdit,
} from "../core/text.ts";
import { MutationError } from "../core/types.ts";
import type {
	ConflictPolicy,
	ConflictResolver,
	OpType,
	TextConflictPolicy,
} from "../core/types.ts";

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
	if (typeof policy === "object") {
		return policy.policy === "custom"
			? resolveCustom(policy.resolve, incoming, existing)
			: resolveText(policy, incoming, existing);
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

function resolveText(
	policy: TextConflictPolicy,
	incoming: ConflictInput,
	existing: ExistingRow,
): ConflictResult {
	if (incoming.op === "delete") return resolveLww(incoming, existing);

	// Two clients seeding one row with the same id: the first one stays.
	if (incoming.op === "insert" && existing.row) {
		return { accepted: true, resolvedRow: existing.row, updatedColClocks: existing.colClocks };
	}

	const { [TEXT_EDIT_KEY]: raw, ...plain } = incoming.payload ?? {};
	const edit = raw as TextEdit | undefined;
	if (edit !== undefined && !isTextEdit(edit, policy)) {
		return {
			accepted: false,
			resolvedRow: existing.row,
			updatedColClocks: existing.colClocks,
			reason: "validation_failed",
		};
	}

	let base: ConflictResult;
	if (Object.keys(plain).length === 0) {
		base = {
			accepted: true,
			resolvedRow: existing.row ?? {},
			updatedColClocks: existing.colClocks,
		};
	} else {
		base = resolveMerge({ ...incoming, payload: plain }, existing);
		if (!base.accepted && !edit) return base;
	}
	if (!edit) return base;

	const row: Record<string, unknown> = { ...base.resolvedRow };
	const clocks: Record<string, string> = { ...base.updatedColClocks };
	const stamp = (column: string, value: unknown) => {
		row[column] = value;
		clocks[column] = incoming.hlc;
	};

	for (const [column, { value, back }] of Object.entries(edit.edits ?? {})) {
		const current = typeof row[column] === "string" ? (row[column] as string) : "";
		const merged = merge3(applyHunks(value, back), current, value);
		if (merged !== row[column]) stamp(column, merged);
		if (policy.softDelete && row[policy.softDelete]) stamp(policy.softDelete, false);
	}

	if (edit.remove && policy.softDelete) {
		const current = row[edit.remove.column];
		if (hashText(typeof current === "string" ? current : "") === edit.remove.baseHash) {
			stamp(policy.softDelete, true);
		}
	}

	const seen = { ...((row[TEXT_SEEN_COLUMN] as Record<string, number> | undefined) ?? {}) };
	delete seen[edit.who];
	seen[edit.who] = edit.n;
	for (const who of Object.keys(seen).slice(0, -TEXT_SEEN_LIMIT)) delete seen[who];
	stamp(TEXT_SEEN_COLUMN, seen);
	clocks._row = incoming.hlc;

	return { accepted: true, resolvedRow: row, updatedColClocks: clocks };
}

function isTextEdit(edit: TextEdit, policy: TextConflictPolicy): boolean {
	if (typeof edit !== "object" || edit === null) return false;
	if (typeof edit.who !== "string" || edit.who.length > 64) return false;
	if (typeof edit.n !== "number") return false;
	for (const [column, change] of Object.entries(edit.edits ?? {})) {
		if (!policy.text.includes(column)) return false;
		if (typeof change?.value !== "string" || !Array.isArray(change.back)) return false;
		// Offsets come from a client, so they can't be allowed to run backwards or past the end.
		let pos = 0;
		for (const hunk of change.back) {
			if (!Array.isArray(hunk) || hunk.length !== 3 || typeof hunk[2] !== "string") return false;
			const [start, end] = hunk;
			if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
			if (start < pos || end < start || end > change.value.length) return false;
			pos = end;
		}
	}
	if (edit.remove) {
		if (!policy.text.includes(edit.remove.column) || !policy.softDelete) return false;
		if (typeof edit.remove.baseHash !== "number") return false;
	}
	return true;
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
