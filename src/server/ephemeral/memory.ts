/**
 * In-process ephemeral store — the default adapter.
 *
 * Stores state as Map<room, Map<key, Map<clientId, EphemeralState>>> and expires
 * entries on a TTL sweep. Single-process by design: it implements no bus, so
 * clients connected to a different instance never see these entries. Reach for
 * the Redis adapter (or a hosted one) once more than one instance serves the
 * same room.
 */

import type { EphemeralAdapter, EphemeralState } from "./types.ts";

const DEFAULT_MAX_ENTRIES = 10_000;

function indexKey(room: string, key: string, clientId: string): string {
	return `${room}\x00${key}\x00${clientId}`;
}

function parseIndexKey(packed: string): { room: string; key: string; clientId: string } {
	const [room, key, clientId] = packed.split("\x00");
	return { room: room!, key: key!, clientId: clientId! };
}

export class EphemeralManager implements EphemeralAdapter {
	// room -> key -> clientId -> state
	private store = new Map<string, Map<string, Map<string, EphemeralState>>>();
	// clientId -> Set<packed-index-key> for fast removal on disconnect.
	// String keys avoid object-identity tracking bugs across set/cleanup paths.
	private clientIndex = new Map<string, Set<string>>();
	private entryCount = 0;
	private maxEntries: number;

	constructor(maxEntries?: number) {
		this.maxEntries = maxEntries ?? DEFAULT_MAX_ENTRIES;
	}

	set(
		room: string,
		key: string,
		clientId: string,
		userId: string,
		data: Record<string, unknown>,
		ttlMs?: number,
	): boolean {
		const roomMap = this.store.get(room) ?? new Map();
		const keyMap = roomMap.get(key) ?? new Map();

		// Check if this is an update (existing entry) or a new entry
		const existing = keyMap.get(clientId) as EphemeralState | undefined;

		// Reject new entries when at capacity. Caller emits ephemeral_full
		// so operators can scale; silent LRU eviction would mask growth.
		if (!existing && this.entryCount >= this.maxEntries) {
			return false;
		}

		const state: EphemeralState = {
			clientId,
			userId,
			key,
			data,
			updatedAt: Date.now(),
			ttlMs,
		};

		keyMap.set(clientId, state);
		roomMap.set(key, keyMap);
		this.store.set(room, roomMap);

		if (!existing) {
			this.entryCount++;
			this.addToClientIndex(clientId, indexKey(room, key, clientId));
		}
		return true;
	}

	private addToClientIndex(clientId: string, packed: string): void {
		const clientSet = this.clientIndex.get(clientId) ?? new Set<string>();
		clientSet.add(packed);
		this.clientIndex.set(clientId, clientSet);
	}

	private removeFromClientIndex(clientId: string, packed: string): void {
		const clientSet = this.clientIndex.get(clientId);
		if (!clientSet) return;
		clientSet.delete(packed);
		if (clientSet.size === 0) this.clientIndex.delete(clientId);
	}

	get(room: string, key: string): Record<string, EphemeralState> {
		const roomMap = this.store.get(room);
		if (!roomMap) return {};

		const keyMap = roomMap.get(key);
		if (!keyMap) return {};

		return Object.fromEntries(keyMap.entries());
	}

	getRoom(room: string): Record<string, Record<string, EphemeralState>> {
		const roomMap = this.store.get(room);
		if (!roomMap) return {};

		const out: Record<string, Record<string, EphemeralState>> = {};
		for (const [key, keyMap] of roomMap) {
			out[key] = Object.fromEntries(keyMap.entries());
		}
		return out;
	}

	remove(room: string, key: string, clientId: string): void {
		const roomMap = this.store.get(room);
		if (!roomMap) return;

		const keyMap = roomMap.get(key);
		if (!keyMap) return;

		if (keyMap.has(clientId)) {
			keyMap.delete(clientId);
			this.entryCount--;
			// Drop the owning client's index entry here rather than at each call
			// site — a caller that forgets leaks a key that never expires.
			this.removeFromClientIndex(clientId, indexKey(room, key, clientId));
		}

		if (keyMap.size === 0) {
			roomMap.delete(key);
		}

		if (roomMap.size === 0) {
			this.store.delete(room);
		}
	}

	removeClient(clientId: string): void {
		const indices = this.clientIndex.get(clientId);
		if (!indices) return;

		// Snapshot to avoid mutating during iteration
		const entries = [...indices];
		for (const packed of entries) {
			const { room, key, clientId: owner } = parseIndexKey(packed);
			this.remove(room, key, owner);
		}

		this.clientIndex.delete(clientId);
	}

	cleanupExpired(): void {
		const now = Date.now();

		// Collect expired entries first, then remove
		const toRemove: Array<{ room: string; key: string; clientId: string }> = [];

		for (const [room, roomMap] of this.store) {
			for (const [key, keyMap] of roomMap) {
				for (const [clientId, state] of keyMap) {
					if (state.ttlMs && now - state.updatedAt > state.ttlMs) {
						toRemove.push({ room, key, clientId });
					}
				}
			}
		}

		for (const { room, key, clientId } of toRemove) {
			this.remove(room, key, clientId);
		}
	}

	size(): number {
		return this.entryCount;
	}

	destroy(): void {
		this.store.clear();
		this.clientIndex.clear();
		this.entryCount = 0;
	}
}

/** Convenience factory mirroring the other adapters. */
export function createMemoryEphemeral(maxEntries?: number): EphemeralManager {
	return new EphemeralManager(maxEntries);
}
