/**
 * Per-client, per-query result cache for change detection.
 * Stores the last-sent result set and diffs against new results.
 *
 * Semantics: diffs broadcast STATE changes, not event counts. Two writes with
 * the same final value produce no delta — by design — because subscribers
 * already hold the resulting state. If your app needs notifications for every
 * write regardless of value (e.g. activity feed), emit ephemeral events
 * separately rather than relying on the result-cache delta stream.
 */

/**
 * Recursive deep equality check that short-circuits on first difference.
 * Handles primitives, null, arrays, and plain objects without creating
 * intermediate strings (unlike JSON.stringify comparison).
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;

	// Date: compare epoch ms. Two different Dates would otherwise have empty
	// Object.keys() and compare equal as plain objects, masking column changes
	// for timestamp fields returned by ORMs (Drizzle, Prisma).
	if (a instanceof Date || b instanceof Date) {
		return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	}

	// Both are non-null objects at this point
	const aIsArray = Array.isArray(a);
	const bIsArray = Array.isArray(b);
	if (aIsArray !== bIsArray) return false;

	if (aIsArray) {
		const aArr = a as unknown[];
		const bArr = b as unknown[];
		if (aArr.length !== bArr.length) return false;
		for (let i = 0; i < aArr.length; i++) {
			if (!deepEqual(aArr[i], bArr[i])) return false;
		}
		return true;
	}

	const aObj = a as Record<string, unknown>;
	const bObj = b as Record<string, unknown>;
	const aKeys = Object.keys(aObj);
	const bKeys = Object.keys(bObj);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
		if (!deepEqual(aObj[key], bObj[key])) return false;
	}
	return true;
}

export interface DiffResult {
	inserted: Array<{ rowId: string; data: Record<string, unknown> }>;
	updated: Array<{ rowId: string; changed: Record<string, unknown> }>;
	deleted: string[];
}

export class ResultCache {
	// clientId → queryName → (rowId → row data)
	private cache = new Map<string, Map<string, Map<string, Record<string, unknown>>>>();

	/**
	 * Update the cached result set and return the diff.
	 * @param idField - The field name used as the row identifier (default: "id")
	 */
	set(
		clientId: string,
		queryName: string,
		rows: Record<string, unknown>[],
		idField = "id",
	): DiffResult {
		const clientCache = this.getOrCreateClientCache(clientId);
		const oldRows = clientCache.get(queryName) ?? new Map<string, Record<string, unknown>>();
		const newRows = new Map<string, Record<string, unknown>>();

		for (const row of rows) {
			const rowId = String(row[idField] ?? "");
			if (rowId) {
				newRows.set(rowId, row);
			}
		}

		const diff = this.diff(oldRows, newRows);
		clientCache.set(queryName, newRows);
		return diff;
	}

	get(clientId: string, queryName: string): Map<string, Record<string, unknown>> {
		return this.cache.get(clientId)?.get(queryName) ?? new Map();
	}

	/**
	 * Compute the diff WITHOUT committing the new rows to the cache. Use when
	 * the broadcast may fail and we need to defer the cache update until sends
	 * succeed — otherwise a dropped send leaves the cache claiming the client
	 * already has rows it never received.
	 */
	diffOnly(
		clientId: string,
		queryName: string,
		rows: Record<string, unknown>[],
		idField = "id",
	): DiffResult {
		const oldRows = this.cache.get(clientId)?.get(queryName) ?? new Map<string, Record<string, unknown>>();
		const newRows = new Map<string, Record<string, unknown>>();
		for (const row of rows) {
			const rowId = String(row[idField] ?? "");
			if (rowId) newRows.set(rowId, row);
		}
		return this.diff(oldRows, newRows);
	}

	clear(clientId: string, queryName: string): void {
		this.cache.get(clientId)?.delete(queryName);
	}

	clearClient(clientId: string): void {
		this.cache.delete(clientId);
	}

	private getOrCreateClientCache(
		clientId: string,
	): Map<string, Map<string, Record<string, unknown>>> {
		let clientCache = this.cache.get(clientId);
		if (!clientCache) {
			clientCache = new Map();
			this.cache.set(clientId, clientCache);
		}
		return clientCache;
	}

	private diff(
		oldRows: Map<string, Record<string, unknown>>,
		newRows: Map<string, Record<string, unknown>>,
	): DiffResult {
		const inserted: DiffResult["inserted"] = [];
		const updated: DiffResult["updated"] = [];
		const deleted: string[] = [];

		// Find inserted and updated rows
		for (const [rowId, newRow] of newRows) {
			const oldRow = oldRows.get(rowId);
			if (!oldRow) {
				inserted.push({ rowId, data: newRow });
			} else {
				const changed = this.fieldDiff(oldRow, newRow);
				if (changed) {
					updated.push({ rowId, changed });
				}
			}
		}

		// Find deleted rows
		for (const rowId of oldRows.keys()) {
			if (!newRows.has(rowId)) {
				deleted.push(rowId);
			}
		}

		return { inserted, updated, deleted };
	}

	/**
	 * Returns only the changed fields, or null if nothing changed.
	 */
	private fieldDiff(
		oldRow: Record<string, unknown>,
		newRow: Record<string, unknown>,
	): Record<string, unknown> | null {
		const changed: Record<string, unknown> = {};
		let hasChanges = false;

		for (const [key, newValue] of Object.entries(newRow)) {
			const oldValue = oldRow[key];
			const equal = deepEqual(oldValue, newValue);
			if (!equal) {
				changed[key] = newValue;
				hasChanges = true;
			}
		}

		// Check for removed fields
		for (const key of Object.keys(oldRow)) {
			if (!(key in newRow)) {
				changed[key] = null;
				hasChanges = true;
			}
		}

		return hasChanges ? changed : null;
	}
}
