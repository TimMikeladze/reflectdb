/**
 * Manages ephemeral (transient, fire-and-forget) events.
 * Stores state in memory: Map<room, Map<key, Map<userId, EphemeralState>>>
 * Auto-expires entries based on TTL.
 */

interface EphemeralState {
	clientId: string;
	userId: string;
	key: string;
	data: Record<string, unknown>;
	updatedAt: number;
	ttlMs?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

function indexKey(room: string, key: string, userId: string): string {
	return `${room}\x00${key}\x00${userId}`;
}

function parseIndexKey(packed: string): { room: string; key: string; userId: string } {
	const [room, key, userId] = packed.split("\x00");
	return { room: room!, key: key!, userId: userId! };
}

export class EphemeralManager {
	// room -> key -> userId -> state
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
		const isUpdate = keyMap.has(userId);

		// Reject new entries when at capacity. Caller emits ephemeral_full
		// so operators can scale; silent LRU eviction would mask growth.
		if (!isUpdate && this.entryCount >= this.maxEntries) {
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

		keyMap.set(userId, state);
		roomMap.set(key, keyMap);
		this.store.set(room, roomMap);

		if (!isUpdate) {
			this.entryCount++;
			const clientSet = this.clientIndex.get(clientId) ?? new Set<string>();
			clientSet.add(indexKey(room, key, userId));
			this.clientIndex.set(clientId, clientSet);
		}
		return true;
	}

	get(room: string, key: string): Record<string, EphemeralState> {
		const roomMap = this.store.get(room);
		if (!roomMap) return {};

		const keyMap = roomMap.get(key);
		if (!keyMap) return {};

		return Object.fromEntries(keyMap.entries());
	}

	remove(room: string, key: string, userId: string): void {
		const roomMap = this.store.get(room);
		if (!roomMap) return;

		const keyMap = roomMap.get(key);
		if (!keyMap) return;

		if (keyMap.has(userId)) {
			keyMap.delete(userId);
			this.entryCount--;
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
			const { room, key, userId } = parseIndexKey(packed);
			this.remove(room, key, userId);
		}

		this.clientIndex.delete(clientId);
	}

	cleanupExpired(): void {
		const now = Date.now();

		// Collect expired entries first, then remove
		const toRemove: Array<{ room: string; key: string; userId: string; clientId: string }> = [];

		for (const [room, roomMap] of this.store) {
			for (const [key, keyMap] of roomMap) {
				for (const [userId, state] of keyMap) {
					if (state.ttlMs && now - state.updatedAt > state.ttlMs) {
						toRemove.push({ room, key, userId, clientId: state.clientId });
					}
				}
			}
		}

		for (const { room, key, userId, clientId } of toRemove) {
			this.remove(room, key, userId);
			const clientSet = this.clientIndex.get(clientId);
			if (clientSet) {
				clientSet.delete(indexKey(room, key, userId));
				if (clientSet.size === 0) {
					this.clientIndex.delete(clientId);
				}
			}
		}
	}

	get size(): number {
		return this.entryCount;
	}

	destroy(): void {
		this.store.clear();
		this.clientIndex.clear();
		this.entryCount = 0;
	}
}
