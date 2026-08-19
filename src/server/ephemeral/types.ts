/**
 * Ephemeral (presence, cursors, typing) storage and fan-out seam.
 *
 * The default adapter keeps state in the server process, which is correct for a
 * single node and invisible across a fleet: two clients on different instances
 * never see each other. An adapter backed by shared infrastructure (Redis, or a
 * hosted service) fixes both halves — the shared store answers "who is here"
 * for a client that just joined, and the bus carries each event to the peers
 * holding the other sockets.
 */

export type MaybePromise<T> = T | Promise<T>;

export interface EphemeralState {
	clientId: string;
	userId: string;
	key: string;
	data: Record<string, unknown>;
	updatedAt: number;
	ttlMs?: number;
}

/** One fan-out target: subscribers of `query`, narrowed to `room` when set. */
export interface EphemeralTarget {
	query: string;
	room: string | null;
}

/**
 * An ephemeral event as it crosses the bus between server instances.
 *
 * Recipients are resolved on the origin instance and carried here as `targets`,
 * because the receiving instance holds no session for the sender and so cannot
 * re-derive them. `serverId` lets an instance drop its own echo on buses that
 * deliver published messages back to the publisher.
 */
export interface EphemeralBroadcast {
	serverId: string;
	key: string;
	clientId: string;
	userId: string;
	data: Record<string, unknown>;
	ttlMs?: number;
	targets: EphemeralTarget[];
}

/**
 * Backing store and fan-out bus for ephemeral state.
 *
 * `publish`/`subscribe` are optional: an adapter that omits them is a
 * single-process store, and the handler still fans out to its own sockets.
 */
export interface EphemeralAdapter {
	/**
	 * Record one entry, keyed by `clientId`.
	 *
	 * Peer identity is the connection, not the account: two tabs from one login
	 * are two cursors, and the client bindings key peers the same way. `userId`
	 * rides along for display and authorization, not as the entry's identity.
	 *
	 * Returns false when the adapter is at capacity, which the handler surfaces
	 * as `ephemeral_full` rather than evicting silently.
	 */
	set(
		room: string,
		key: string,
		clientId: string,
		userId: string,
		data: Record<string, unknown>,
		ttlMs?: number,
	): MaybePromise<boolean>;

	/** Live entries for one channel, keyed by clientId. */
	get(room: string, key: string): MaybePromise<Record<string, EphemeralState>>;

	/**
	 * Live entries for every channel in a room, keyed by channel key then
	 * clientId. Backs the snapshot a client receives when it joins.
	 */
	getRoom(room: string): MaybePromise<Record<string, Record<string, EphemeralState>>>;

	remove(room: string, key: string, clientId: string): MaybePromise<void>;

	/** Drop everything a disconnecting client published. */
	removeClient(clientId: string): MaybePromise<void>;

	/** Sweep entries past their TTL. Called on a timer by the handler. */
	cleanupExpired(): MaybePromise<void>;

	/** Current entry count, for the capacity gate and `ephemeral_full`. */
	size(): MaybePromise<number>;

	destroy(): MaybePromise<void>;

	/** Hand an event to peer instances. Absent on single-process adapters. */
	publish?(event: EphemeralBroadcast): MaybePromise<void>;

	/**
	 * Register the handler's delivery callback for events published by peers.
	 * Called once during wiring. Absent on single-process adapters.
	 */
	subscribe?(onEvent: (event: EphemeralBroadcast) => void): MaybePromise<void>;
}
