import type { LocalRow, PendingOp } from "../store.ts";

export interface ClientStorageAdapter {
	// Rows
	getRows(table: string): Promise<LocalRow[]>;
	getAllRows(): Promise<LocalRow[]>;
	putRow(table: string, rowId: string, row: LocalRow): Promise<void>;
	deleteRow(table: string, rowId: string): Promise<void>;
	clearTable(table: string): Promise<void>;

	// Pending ops
	getPendingOps(): Promise<PendingOp[]>;
	putPendingOps(ops: PendingOp[]): Promise<void>;
	appendPendingOps(ops: PendingOp[]): Promise<void>;
	updatePendingOps(ops: PendingOp[]): Promise<void>;
	removePendingOps(opIds: string[]): Promise<void>;
	clearPendingOps(): Promise<void>;

	// Key-value metadata (serverHlc, hlcState, tableMeta, syncSubscriptions)
	getMeta(key: string): Promise<string | null>;
	setMeta(key: string, value: string): Promise<void>;
	deleteMeta(key: string): Promise<void>;

	// Full reset (logout)
	clear(): Promise<void>;
}
