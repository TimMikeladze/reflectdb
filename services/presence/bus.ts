/**
 * Cross-instance fan-out for the presence service.
 *
 * The service owns its own bus rather than borrowing reflectdb's: a presence
 * room is addressed by name, while a reflectdb ephemeral event is addressed by
 * the sender's query subscriptions. Same Redis, different envelope.
 */

import type { RedisLike, RedisSubscriberLike } from "../../src/server/ephemeral/redis.ts";
import type { LeaveFrame, PresenceFrame } from "./protocol.ts";

export interface BusMessage {
	/** Publishing instance, so a bus that echoes does not double-deliver. */
	origin: string;
	/** Project-namespaced room key. */
	room: string;
	frame: PresenceFrame | LeaveFrame;
}

export interface PresenceBus {
	publish(message: BusMessage): Promise<void>;
	subscribe(onMessage: (message: BusMessage) => void): Promise<void>;
	close(): void;
}

export interface PresenceBusConfig {
	client: RedisLike;
	subscriber?: RedisSubscriberLike;
	prefix?: string;
	serverId: string;
}

/**
 * A bus with no subscriber connection still publishes — useful for a
 * single-instance deployment, where local fan-out already reaches everyone.
 */
export function createPresenceBus(config: PresenceBusConfig): PresenceBus {
	const channel = `${config.prefix ?? "presence"}:bus`;
	let listener: ((message: BusMessage) => void) | null = null;

	return {
		async publish(message: BusMessage): Promise<void> {
			await config.client.call("PUBLISH", channel, JSON.stringify(message));
		},

		async subscribe(onMessage: (message: BusMessage) => void): Promise<void> {
			listener = onMessage;
			if (!config.subscriber) return;
			await config.subscriber.subscribe(channel, (payload) => {
				if (!listener) return;
				let message: BusMessage;
				try {
					message = JSON.parse(payload) as BusMessage;
				} catch {
					// A malformed frame must not take the bus listener down.
					return;
				}
				if (message.origin === config.serverId) return;
				listener(message);
			});
		},

		close(): void {
			listener = null;
		},
	};
}
