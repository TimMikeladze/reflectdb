import {
	diffText,
	hashText,
	mapOffset,
	merge3,
	TEXT_EDIT_KEY,
	TEXT_SEEN_COLUMN,
	type TextEdit,
} from "../core/text.ts";
import type { ErrorReason } from "../core/types.ts";
import type { SyncClient } from "./sync-client.ts";

export type TextBindingOptions = {
	/** How often a changed value is sent, in ms. Default 50. */
	flushMs?: number;
	/** The server refused an edit for good. The local text has gone back to the server's. */
	onError?: (reason: ErrorReason) => void;
};

/** Worth retrying: nothing is wrong with the edit itself. */
const RETRYABLE = new Set<ErrorReason>(["rate_limited", "buffer_full", "server_error"]);
const RETRY_MS = 500;
const MAX_RETRIES = 5;

/**
 * One text column of one row, as something you can type into. `get()` is what
 * you render. It stays ahead of the server while you type, and takes other
 * people's edits as they arrive, moving the caret with them.
 *
 * One write is in flight at a time. The row's `_seen` column says when the text
 * in the store includes that write, and only then is it merged into what you've
 * typed since. Merging any earlier would apply your own in-flight edit twice.
 *
 * The store's row isn't touched optimistically, so `getRow()` and `useRow()` show
 * the server's text while `get()` shows yours.
 */
export class TextBinding {
	private shadow = "";
	private local = "";
	private sent = "";
	private flight = 0;
	private opId: string | null = null;
	private retries = 0;
	private cursor = 0;
	private exists = false;
	private removing = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribe: (() => void) | null = null;
	private unsubscribeOps: (() => void) | null = null;
	private listeners = new Set<() => void>();

	constructor(
		private client: SyncClient,
		readonly table: string,
		readonly rowId: string,
		readonly column: string,
		private options: TextBindingOptions = {},
	) {
		this.open();
	}

	/** Start following the row. The constructor calls it; call it again to reuse a closed binding. */
	open(): void {
		if (this.unsubscribe) return;
		this.unsubscribe = this.client.subscribeTable(this.table, this.pump);
		this.unsubscribeOps = this.client.onOpRejected(this.onRejected);
		this.pump();
	}

	/** Sends what's unsent and stops following the row. */
	close(): void {
		this.flush();
		this.unsubscribe?.();
		this.unsubscribeOps?.();
		this.unsubscribe = null;
		this.unsubscribeOps = null;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/** The text to render. An arrow so it can go straight to `useSyncExternalStore`. */
	get = (): string => this.local;

	caret(): number {
		return this.cursor;
	}

	/** Whether the row has arrived. `set` before then waits for it. */
	ready(): boolean {
		return this.exists;
	}

	set(next: string, caret?: number): void {
		if (next === this.local && caret === undefined) return;
		this.cursor = caret ?? mapOffset(this.local, next, this.cursor);
		this.local = next;
		this.schedule(this.options.flushMs ?? 50);
		this.notify();
	}

	setCaret(caret: number): void {
		this.cursor = caret;
	}

	/**
	 * Set the row's `softDelete` column. If someone else's edit gets there first, this
	 * does nothing and the row stays, because the edit wins. Unsent local typing is dropped.
	 */
	remove(): void {
		this.removing = true;
		this.local = this.shadow;
		this.schedule(0);
		this.notify();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** Send now rather than on the next tick. Does nothing while a write is in flight. */
	flush(): void {
		if (this.flight || !this.exists) return;
		const edit: TextEdit = { who: this.client.textWriterId, n: 0 };
		if (this.removing) {
			edit.remove = { column: this.column, baseHash: hashText(this.shadow) };
			this.removing = false;
		} else if (this.local !== this.shadow) {
			edit.edits = {
				[this.column]: { value: this.local, back: diffText(this.local, this.shadow) },
			};
		} else return;
		edit.n = this.client.nextTextWrite();
		this.flight = edit.n;
		this.sent = this.local;
		this.opId = this.client.update(this.table, this.rowId, { [TEXT_EDIT_KEY]: edit }).id;
	}

	private schedule(ms: number): void {
		if (this.timer || !this.unsubscribe) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, ms);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private pump = (): void => {
		const row = this.client.getRow(this.table, this.rowId);
		if (!row) {
			this.exists = false;
			this.flight = 0;
			return;
		}
		const raw = row[this.column];
		const server = typeof raw === "string" ? raw : "";

		if (!this.exists) {
			this.exists = true;
			// Anything typed before the row arrived goes on top of it.
			if (this.local === this.shadow) {
				this.cursor = Math.min(this.cursor, server.length);
				this.local = server;
			} else {
				this.local = merge3(this.shadow, server, this.local);
			}
			this.shadow = server;
			if (this.local !== this.shadow) this.schedule(0);
			this.notify();
			return;
		}

		const seen = (row[TEXT_SEEN_COLUMN] as Record<string, number> | undefined)?.[
			this.client.textWriterId
		];
		if (this.flight && (seen ?? 0) < this.flight) return;

		const from = this.flight ? this.sent : this.shadow;
		const settled = this.flight !== 0;
		this.flight = 0;
		this.opId = null;
		if (settled) this.retries = 0;
		if (server !== this.shadow || from !== server) {
			const merged = merge3(from, server, this.local);
			this.cursor = mapOffset(this.local, merged, this.cursor);
			const changed = merged !== this.local;
			this.local = merged;
			this.shadow = server;
			if (changed) this.notify();
		}
		if (settled && (this.local !== this.shadow || this.removing)) {
			this.schedule(this.options.flushMs ?? 50);
		}
	};

	private onRejected = (opId: string, reason: ErrorReason): void => {
		if (opId !== this.opId) return;
		this.flight = 0;
		this.opId = null;
		if (RETRYABLE.has(reason) && this.retries < MAX_RETRIES) {
			this.retries++;
			this.schedule(RETRY_MS);
			return;
		}
		this.retries = 0;
		this.local = this.shadow;
		this.cursor = Math.min(this.cursor, this.local.length);
		this.notify();
		this.options.onError?.(reason);
	};
}
