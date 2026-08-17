import { sendHlc, packHlc } from "../core/hlc.ts";
import type { HLC } from "../core/hlc.ts";
import type { ClientOp, OpType } from "../core/types.ts";

// crypto.randomUUID requires Safari ≥15.4 / Node ≥14.17. Fall back to a
// getRandomValues-based v4 generator (or Math.random as last resort) so older
// runtimes don't crash on every op.
function randomUUID(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	const bytes = new Uint8Array(16);
	if (c?.getRandomValues) {
		c.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex: string[] = [];
	for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export interface OpCreator {
	insert(table: string, rowId: string, payload: Record<string, unknown>): ClientOp;
	update(table: string, rowId: string, payload: Record<string, unknown>): ClientOp;
	delete(table: string, rowId: string): ClientOp;
	createBatch(
		ops: Array<{
			table: string;
			op: OpType;
			rowId: string;
			payload: Record<string, unknown> | null;
		}>,
	): ClientOp[];
	getHlc(): HLC;
}

export function createOpCreator(nodeId: string, initialHlc?: HLC): OpCreator {
	let hlc: HLC = initialHlc ?? { ms: 0, counter: 0, nodeId };

	function nextOp(
		table: string,
		op: OpType,
		rowId: string,
		payload: Record<string, unknown> | null,
	): ClientOp {
		hlc = sendHlc(hlc);
		return {
			id: randomUUID(),
			table,
			op,
			rowId,
			payload,
			hlc: packHlc(hlc),
		};
	}

	return {
		insert(table, rowId, payload) {
			return nextOp(table, "insert", rowId, payload);
		},

		update(table, rowId, payload) {
			return nextOp(table, "update", rowId, payload);
		},

		delete(table, rowId) {
			return nextOp(table, "delete", rowId, null);
		},

		createBatch(ops) {
			const batchId = randomUUID();
			return ops.map((spec, i) => {
				const op = nextOp(spec.table, spec.op, spec.rowId, spec.payload);
				return {
					...op,
					batchId,
					batchSize: ops.length,
					batchSeq: i,
				};
			});
		},

		getHlc() {
			return hlc;
		},
	};
}
