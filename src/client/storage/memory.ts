import type { LocalRow, PendingOp } from "../store.ts";
import type { ClientStorageAdapter } from "./types.ts";

export function createMemoryStorage(): ClientStorageAdapter {
	const rows = new Map<string, Map<string, LocalRow>>();
	let pendingOps: PendingOp[] = [];
	const meta = new Map<string, string>();

	return {
		async getRows(table) {
			return Array.from(rows.get(table)?.values() ?? []);
		},

		async getAllRows() {
			const all: LocalRow[] = [];
			for (const tableRows of rows.values()) {
				for (const row of tableRows.values()) {
					all.push(row);
				}
			}
			return all;
		},

		async putRow(table, rowId, row) {
			let tableRows = rows.get(table);
			if (!tableRows) {
				tableRows = new Map();
				rows.set(table, tableRows);
			}
			tableRows.set(rowId, row);
		},

		async deleteRow(table, rowId) {
			rows.get(table)?.delete(rowId);
		},

		async clearTable(table) {
			rows.delete(table);
		},

		async getPendingOps() {
			return [...pendingOps];
		},

		async putPendingOps(ops) {
			pendingOps = [...ops];
		},

		async appendPendingOps(ops) {
			pendingOps.push(...ops);
		},

		async updatePendingOps(ops) {
			const updateMap = new Map<string, PendingOp>();
			for (const op of ops) {
				updateMap.set(op.op.id, op);
			}
			for (let i = 0; i < pendingOps.length; i++) {
				const updated = updateMap.get(pendingOps[i]!.op.id);
				if (updated) {
					pendingOps[i] = updated;
				}
			}
		},

		async removePendingOps(opIds) {
			const idSet = new Set(opIds);
			pendingOps = pendingOps.filter((p) => !idSet.has(p.op.id));
		},

		async clearPendingOps() {
			pendingOps = [];
		},

		async getMeta(key) {
			return meta.get(key) ?? null;
		},

		async setMeta(key, value) {
			meta.set(key, value);
		},

		async deleteMeta(key) {
			meta.delete(key);
		},

		async clear() {
			rows.clear();
			pendingOps = [];
			meta.clear();
		},
	};
}
