import type { LocalRow, PendingOp } from "../store.ts";
import type { ClientStorageAdapter } from "./types.ts";

export interface IndexedDBMigrationContext {
	db: IDBDatabase;
	transaction: IDBTransaction;
	oldVersion: number;
	newVersion: number;
}

export function createIndexedDBStorage(config: {
	dbName: string;
	version?: number;
	/**
	 * Called during onupgradeneeded after the built-in stores are ensured.
	 * Bump `version` and handle old→new schema changes here. Without this,
	 * raising `version` in app code with no migration wipes user data.
	 */
	migrate?: (ctx: IndexedDBMigrationContext) => void;
	/**
	 * Application-level schema version (separate from IDB `version`).
	 * Persisted to meta on first open. On subsequent opens, mismatch fires
	 * `onSchemaChange` so the app can clear or migrate row data whose shape
	 * changed without an IDB version bump (e.g. new required field added to
	 * a Drizzle table).
	 */
	appSchemaVersion?: number;
	/** Invoked when stored appSchemaVersion differs from config. Default: warn. */
	onSchemaChange?: (
		ctx: { storedVersion: number; configVersion: number },
		storage: ClientStorageAdapter,
	) => void | Promise<void>;
}): ClientStorageAdapter {
	let dbPromise: Promise<IDBDatabase> | null = null;
	let schemaChecked = false;

	function openDB(): Promise<IDBDatabase> {
		if (dbPromise) return dbPromise;
		dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(config.dbName, config.version ?? 1);
			request.onupgradeneeded = (event) => {
				const db = request.result;
				const transaction = request.transaction;
				if (!db.objectStoreNames.contains("rows")) {
					const rowStore = db.createObjectStore("rows", { keyPath: ["table", "rowId"] });
					rowStore.createIndex("table", "table", { unique: false });
				}
				if (!db.objectStoreNames.contains("pendingOps")) {
					db.createObjectStore("pendingOps", { keyPath: "op.id" });
				}
				if (!db.objectStoreNames.contains("meta")) {
					db.createObjectStore("meta", { keyPath: "key" });
				}
				if (config.migrate && transaction) {
					config.migrate({
						db,
						transaction,
						oldVersion: event.oldVersion,
						newVersion: event.newVersion ?? (config.version ?? 1),
					});
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return dbPromise;
	}

	function tx(
		storeNames: string | string[],
		mode: IDBTransactionMode,
	): Promise<{ tx: IDBTransaction; stores: Record<string, IDBObjectStore> }> {
		return openDB().then((db) => {
			const names = Array.isArray(storeNames) ? storeNames : [storeNames];
			const transaction = db.transaction(names, mode);
			const stores: Record<string, IDBObjectStore> = {};
			for (const name of names) {
				stores[name] = transaction.objectStore(name);
			}
			return { tx: transaction, stores };
		});
	}

	function reqToPromise<T>(request: IDBRequest<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	function txComplete(transaction: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
	}

	async function readMetaRaw(key: string): Promise<string | null> {
		const { stores } = await tx("meta", "readonly");
		const result = await reqToPromise(stores.meta!.get(key));
		return (result as { key: string; value: string } | undefined)?.value ?? null;
	}

	async function writeMetaRaw(key: string, value: string): Promise<void> {
		const { tx: transaction, stores } = await tx("meta", "readwrite");
		stores.meta!.put({ key, value });
		await txComplete(transaction);
	}

	let schemaCheckPromise: Promise<void> | null = null;
	async function ensureSchemaChecked(): Promise<void> {
		if (schemaChecked) return;
		// Coalesce concurrent callers + retry on failure: setting schemaChecked
		// before await means a thrown migration leaves us flagged as "done"
		// while no version was persisted. Use a promise guard so concurrent
		// calls share one in-flight check; on rejection, clear so the next
		// call retries.
		if (schemaCheckPromise) return schemaCheckPromise;
		schemaCheckPromise = (async () => {
			if (config.appSchemaVersion === undefined) {
				schemaChecked = true;
				return;
			}
			const storedRaw = await readMetaRaw("__reflectdb_appSchemaVersion");
			const stored = storedRaw == null ? null : Number.parseInt(storedRaw, 10);
			if (stored === null) {
				await writeMetaRaw("__reflectdb_appSchemaVersion", String(config.appSchemaVersion));
				schemaChecked = true;
				return;
			}
			if (stored !== config.appSchemaVersion) {
				if (config.onSchemaChange) {
					await config.onSchemaChange(
						{ storedVersion: stored, configVersion: config.appSchemaVersion },
						adapter,
					);
				} else {
					console.warn(
						`[reflectdb] IndexedDB appSchemaVersion mismatch: stored=${stored} config=${config.appSchemaVersion}. ` +
							`Pass onSchemaChange to handle (e.g. await storage.clear()).`,
					);
				}
				await writeMetaRaw("__reflectdb_appSchemaVersion", String(config.appSchemaVersion));
			}
			schemaChecked = true;
		})().catch((err) => {
			// Reset so the next caller retries the migration instead of
			// silently skipping it.
			schemaCheckPromise = null;
			throw err;
		});
		return schemaCheckPromise;
	}

	const adapter: ClientStorageAdapter = {
		async getRows(table) {
			await ensureSchemaChecked();
			const { stores } = await tx("rows", "readonly");
			const index = stores.rows!.index("table");
			const results = await reqToPromise(index.getAll(table));
			return results as LocalRow[];
		},

		async getAllRows() {
			const { stores } = await tx("rows", "readonly");
			const results = await reqToPromise(stores.rows!.getAll());
			return results as LocalRow[];
		},

		async putRow(table, rowId, row) {
			const { tx: transaction, stores } = await tx("rows", "readwrite");
			stores.rows!.put(row);
			await txComplete(transaction);
		},

		async deleteRow(table, rowId) {
			const { tx: transaction, stores } = await tx("rows", "readwrite");
			stores.rows!.delete([table, rowId]);
			await txComplete(transaction);
		},

		async clearTable(table) {
			const { tx: transaction, stores } = await tx("rows", "readwrite");
			const index = stores.rows!.index("table");
			const keys = await reqToPromise(index.getAllKeys(table));
			// Issue all deletes synchronously so the IDB scheduler keeps the
			// transaction alive until txComplete resolves. Awaiting per-iteration
			// risks the tx going inactive between microtasks on some impls,
			// silently dropping later deletes.
			const deletes = keys.map((key) => reqToPromise(stores.rows!.delete(key)));
			await Promise.all(deletes);
			await txComplete(transaction);
		},

		async getPendingOps() {
			const { stores } = await tx("pendingOps", "readonly");
			const results = await reqToPromise(stores.pendingOps!.getAll());
			return results as PendingOp[];
		},

		async putPendingOps(ops) {
			const { tx: transaction, stores } = await tx("pendingOps", "readwrite");
			// Clear and rewrite
			stores.pendingOps!.clear();
			for (const op of ops) {
				stores.pendingOps!.put(op);
			}
			await txComplete(transaction);
		},

		async appendPendingOps(ops) {
			const { tx: transaction, stores } = await tx("pendingOps", "readwrite");
			for (const op of ops) {
				stores.pendingOps!.put(op);
			}
			await txComplete(transaction);
		},

		async updatePendingOps(ops) {
			const { tx: transaction, stores } = await tx("pendingOps", "readwrite");
			for (const op of ops) {
				stores.pendingOps!.put(op);
			}
			await txComplete(transaction);
		},

		async removePendingOps(opIds) {
			const { tx: transaction, stores } = await tx("pendingOps", "readwrite");
			for (const id of opIds) {
				stores.pendingOps!.delete(id);
			}
			await txComplete(transaction);
		},

		async clearPendingOps() {
			const { tx: transaction, stores } = await tx("pendingOps", "readwrite");
			stores.pendingOps!.clear();
			await txComplete(transaction);
		},

		async getMeta(key) {
			const { stores } = await tx("meta", "readonly");
			const result = await reqToPromise(stores.meta!.get(key));
			return (result as { key: string; value: string } | undefined)?.value ?? null;
		},

		async setMeta(key, value) {
			const { tx: transaction, stores } = await tx("meta", "readwrite");
			stores.meta!.put({ key, value });
			await txComplete(transaction);
		},

		async deleteMeta(key) {
			const { tx: transaction, stores } = await tx("meta", "readwrite");
			stores.meta!.delete(key);
			await txComplete(transaction);
		},

		async clear() {
			const { tx: transaction, stores } = await tx(["rows", "pendingOps", "meta"], "readwrite");
			stores.rows!.clear();
			stores.pendingOps!.clear();
			stores.meta!.clear();
			await txComplete(transaction);
			// Reset cached db so next open is fresh if needed
			dbPromise = null;
		},
	};

	// Wrap hydration paths so the schema check runs lazily on first read.
	const _getAllRows = adapter.getAllRows;
	adapter.getAllRows = async () => {
		await ensureSchemaChecked();
		return _getAllRows();
	};
	const _getPendingOps = adapter.getPendingOps;
	adapter.getPendingOps = async () => {
		await ensureSchemaChecked();
		return _getPendingOps();
	};

	return adapter;
}
