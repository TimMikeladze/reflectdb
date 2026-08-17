import type { AuthContext } from "../core/types.ts";
import type { QueryOptions } from "./types.ts";

export interface ClientSession<TAuth extends AuthContext = AuthContext> {
	clientId: string;
	auth: TAuth | null;
	subscriptions: Map<string, QuerySubscription>;
	watermark: string | null;
	connectedAt: number;
}

export interface QuerySubscription {
	queryName: string;
	params: Record<string, unknown>;
	options: QueryOptions;
	roomKey: string | null;
	/** Window the client asked for at subscribe time. Null = unwindowed. */
	windowSize: number | null;
	/**
	 * How many rows the client is currently entitled to: `windowSize` plus every
	 * `load_more` since. Distinct from `loadedCount`, which is how many rows it
	 * actually holds — a client whose query matched 3 rows for a window of 50 is
	 * still entitled to 50, so the next 47 inserts must reach it.
	 */
	windowLimit: number;
	loadedCount: number;
	lastTotalCount: number | null;
	bootstrapped: boolean;
}

export class SessionManager<TAuth extends AuthContext = AuthContext> {
	private sessions = new Map<string, ClientSession<TAuth>>();
	// Reverse index: queryName -> Set<clientId> for O(subscribers) lookup
	private querySubscribers = new Map<string, Set<string>>();
	// Per-user clientId set so we can enforce a cap without scanning all sessions.
	private userSessions = new Map<string, Set<string>>();

	connect(clientId: string): ClientSession<TAuth> {
		const session: ClientSession<TAuth> = {
			clientId,
			auth: null,
			subscriptions: new Map(),
			watermark: null,
			connectedAt: Date.now(),
		};
		this.sessions.set(clientId, session);
		return session;
	}

	disconnect(clientId: string): void {
		const session = this.sessions.get(clientId);
		if (session) {
			for (const queryName of session.subscriptions.keys()) {
				const subs = this.querySubscribers.get(queryName);
				if (subs) {
					subs.delete(clientId);
					if (subs.size === 0) this.querySubscribers.delete(queryName);
				}
			}
			if (session.auth) {
				const userId = session.auth.userId;
				const set = this.userSessions.get(userId);
				if (set) {
					set.delete(clientId);
					if (set.size === 0) this.userSessions.delete(userId);
				}
			}
		}
		this.sessions.delete(clientId);
	}

	/** Count of active sessions for a given userId. */
	countForUser(userId: string): number {
		return this.userSessions.get(userId)?.size ?? 0;
	}

	/** Oldest (by connectedAt) session for a given userId. */
	oldestForUser(userId: string): ClientSession<TAuth> | null {
		const ids = this.userSessions.get(userId);
		if (!ids || ids.size === 0) return null;
		let oldest: ClientSession<TAuth> | null = null;
		for (const id of ids) {
			const s = this.sessions.get(id);
			if (!s) continue;
			if (!oldest || s.connectedAt < oldest.connectedAt) oldest = s;
		}
		return oldest;
	}

	get(clientId: string): ClientSession<TAuth> | undefined {
		return this.sessions.get(clientId);
	}

	setAuth(clientId: string, auth: TAuth): void {
		const session = this.sessions.get(clientId);
		if (session) {
			// Remove from old user bucket if re-auth changes identity.
			if (session.auth && session.auth.userId !== auth.userId) {
				const prev = this.userSessions.get(session.auth.userId);
				if (prev) {
					prev.delete(clientId);
					if (prev.size === 0) this.userSessions.delete(session.auth.userId);
				}
			}
			session.auth = auth;
			let set = this.userSessions.get(auth.userId);
			if (!set) {
				set = new Set();
				this.userSessions.set(auth.userId, set);
			}
			set.add(clientId);
		}
	}

	subscribe(
		clientId: string,
		queryName: string,
		params: Record<string, unknown>,
		options: QueryOptions,
		roomKey: string | null = null,
		windowSize: number | null = null,
	): void {
		const session = this.sessions.get(clientId);
		if (session) {
			// A non-positive window is not a window — otherwise it would clamp the
			// subscriber to zero rows forever.
			const effectiveWindow = windowSize != null && windowSize > 0 ? windowSize : null;
			session.subscriptions.set(queryName, {
				queryName,
				params,
				options,
				roomKey,
				windowSize: effectiveWindow,
				windowLimit: effectiveWindow ?? 0,
				loadedCount: 0,
				lastTotalCount: null,
				bootstrapped: false,
			});
			// Update reverse index
			let subs = this.querySubscribers.get(queryName);
			if (!subs) {
				subs = new Set();
				this.querySubscribers.set(queryName, subs);
			}
			subs.add(clientId);
		}
	}

	unsubscribe(clientId: string, queryName: string): void {
		const session = this.sessions.get(clientId);
		if (session) {
			session.subscriptions.delete(queryName);
			// Update reverse index
			const subs = this.querySubscribers.get(queryName);
			if (subs) {
				subs.delete(clientId);
				if (subs.size === 0) this.querySubscribers.delete(queryName);
			}
		}
	}

	updateWatermark(clientId: string, hlc: string): void {
		const session = this.sessions.get(clientId);
		if (session) {
			if (!session.watermark || hlc > session.watermark) {
				session.watermark = hlc;
			}
		}
	}

	/**
	 * Get all subscribers for a specific query name.
	 * Uses reverse index for O(subscribers) lookup instead of O(all sessions).
	 */
	getSubscribersForQuery(queryName: string, roomKey?: string | null): ClientSession<TAuth>[] {
		const clientIds = this.querySubscribers.get(queryName);
		if (!clientIds) return [];

		const result: ClientSession<TAuth>[] = [];
		for (const clientId of clientIds) {
			const session = this.sessions.get(clientId);
			if (!session) continue;

			if (roomKey !== undefined && roomKey !== null) {
				const sub = session.subscriptions.get(queryName);
				if (!sub || sub.roomKey !== roomKey) continue;
			}

			result.push(session);
		}
		return result;
	}

	/**
	 * Get all subscribers that have a query depending on a given table.
	 * Uses reverse index for efficient lookup.
	 */
	getSubscribersForTableDependency(
		tableDependencyIndex: Map<string, Set<string>>,
		tableName: string,
	): Array<{ session: ClientSession<TAuth>; queryName: string }> {
		const affectedQueries = tableDependencyIndex.get(tableName);
		if (!affectedQueries) return [];

		const result: Array<{ session: ClientSession<TAuth>; queryName: string }> = [];
		for (const queryName of affectedQueries) {
			const clientIds = this.querySubscribers.get(queryName);
			if (!clientIds) continue;
			for (const clientId of clientIds) {
				const session = this.sessions.get(clientId);
				if (session) {
					result.push({ session, queryName });
				}
			}
		}
		return result;
	}

	getAll(): ClientSession<TAuth>[] {
		return Array.from(this.sessions.values());
	}

	size(): number {
		return this.sessions.size;
	}
}
