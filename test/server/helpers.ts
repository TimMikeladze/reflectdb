import type { ClientMessage, ServerMessage, ServerTransport } from "../../src/core/types.ts";
import { TransportSendError } from "../../src/core/types.ts";

export function createMockTransport(): ServerTransport & {
	sentMessages: Array<{ clientId: string; message: ServerMessage }>;
	broadcastedMessages: Array<{
		roomId: string;
		message: ServerMessage;
		exclude?: string;
	}>;
	messageHandler: ((clientId: string, message: ClientMessage) => void) | null;
	connectHandler: ((clientId: string, req: Request) => void) | null;
	disconnectHandler: ((clientId: string) => void) | null;
	/**
	 * Return true to make `send` reject instead of recording the message —
	 * simulates a transport that reports a dropped frame.
	 */
	failSend: ((clientId: string, message: ServerMessage) => boolean) | null;
	/** Milliseconds `send` should take — widens the window between concurrent broadcasts. */
	sendDelay: ((clientId: string, message: ServerMessage) => number) | null;
} {
	const transport = {
		sentMessages: [] as Array<{ clientId: string; message: ServerMessage }>,
		broadcastedMessages: [] as Array<{
			roomId: string;
			message: ServerMessage;
			exclude?: string;
		}>,
		messageHandler: null as ((clientId: string, message: ClientMessage) => void) | null,
		connectHandler: null as ((clientId: string, req: Request) => void) | null,
		disconnectHandler: null as ((clientId: string) => void) | null,
		failSend: null as ((clientId: string, message: ServerMessage) => boolean) | null,
		sendDelay: null as ((clientId: string, message: ServerMessage) => number) | null,

		async send(clientId: string, message: ServerMessage): Promise<void> {
			if (transport.failSend?.(clientId, message)) {
				throw new TransportSendError(clientId, "mock transport: send failed");
			}
			const delay = transport.sendDelay?.(clientId, message) ?? 0;
			if (delay > 0) await new Promise((r) => setTimeout(r, delay));
			transport.sentMessages.push({ clientId, message });
		},
		async broadcast(roomId: string, message: ServerMessage, exclude?: string): Promise<void> {
			transport.broadcastedMessages.push({ roomId, message, exclude });
		},
		onMessage(handler: (clientId: string, message: ClientMessage) => void): void {
			transport.messageHandler = handler;
		},
		onConnect(handler: (clientId: string, req: Request) => void): void {
			transport.connectHandler = handler;
		},
		onDisconnect(handler: (clientId: string) => void): void {
			transport.disconnectHandler = handler;
		},
		async close(): Promise<void> {},
	};
	return transport;
}
