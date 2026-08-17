import { runStorageAdapterSuite } from "./storage-adapter-suite.ts";
import type { StorageAdapter, OpLogEntry } from "../../../src/server/handler.ts";

/** In-memory storage adapter — identical to the one in server-integration tests but with full op log support. */
function createInMemoryStorage(): StorageAdapter & { close(): void } {
	const store = new Map<
		string,
		{ row: Record<string, unknown>; colClocks: Record<string, string>; hlc: string }
	>();
	const opLog: OpLogEntry[] = [];
	const processedOps = new Set<string>();
	const meta = new Map<string, string>();

	return {
		async getRow(table, rowId) {
			const entry = store.get(`${table}:${rowId}`);
			if (!entry) return { row: null, rowHlc: null, colClocks: {} };
			return { row: entry.row, rowHlc: entry.hlc, colClocks: entry.colClocks };
		},

		async putRow(table, rowId, row, colClocks, hlc) {
			if (row === null) store.delete(`${table}:${rowId}`);
			else store.set(`${table}:${rowId}`, { row, colClocks, hlc });
		},

		async getRows(table) {
			const rows: Record<string, unknown>[] = [];
			const colClocks: Record<string, Record<string, string>> = {};
			for (const [key, entry] of store) {
				if (key.startsWith(`${table}:`)) {
					rows.push(entry.row);
					colClocks[key.split(":")[1]!] = entry.colClocks;
				}
			}
			return { rows, colClocks };
		},

		async appendOp(entry: OpLogEntry) {
			opLog.push(entry);
		},

		async getOpsSince(since: string, tables: string[]) {
			const tableSet = new Set(tables);
			return opLog
				.filter((e) => e.hlc > since && tableSet.has(e.table))
				.sort((a, b) => a.hlc.localeCompare(b.hlc));
		},

		async deleteOpsBefore(hlc: string) {
			const before = opLog.length;
			const kept = opLog.filter((e) => e.hlc >= hlc);
			opLog.length = 0;
			opLog.push(...kept);
			return before - kept.length;
		},

		async reserveOp(opId: string) {
			if (processedOps.has(opId)) return false;
			processedOps.add(opId);
			return true;
		},

		async getMeta(key: string) {
			return meta.get(key) ?? null;
		},

		async setMeta(key: string, value: string) {
			meta.set(key, value);
		},

		close() {},
	};
}

runStorageAdapterSuite("In-Memory", createInMemoryStorage);
