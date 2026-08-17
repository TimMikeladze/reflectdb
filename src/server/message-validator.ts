import type { ClientMessage } from "../core/types.ts";

const VALID_CLIENT_MESSAGE_TYPES = new Set([
	"hello",
	"bootstrap",
	"resume",
	"ops",
	"sync_declare",
	"load_more",
	"unsync",
	"auth",
	"ephemeral",
]);

const VALID_OP_TYPES = new Set(["insert", "update", "delete"]);

// Hard caps: callers can hit handler-level limits (rate limit, batch size,
// max message bytes), but the validator must reject obvious abuse before
// any further work happens.
const MAX_OPS_ARRAY = 10_000;
const MAX_LOAD_MORE_COUNT = 100_000;

/**
 * Validate an incoming client message has the required fields for its type.
 * Returns null if valid, or an error string describing the problem.
 */
export function validateClientMessage(
	msg: unknown,
): { valid: true; message: ClientMessage } | { valid: false; error: string } {
	if (msg == null || typeof msg !== "object") {
		return { valid: false, error: "message is not an object" };
	}

	const m = msg as Record<string, unknown>;

	if (typeof m.type !== "string" || !VALID_CLIENT_MESSAGE_TYPES.has(m.type)) {
		return { valid: false, error: `invalid message type: ${JSON.stringify(m.type)}` };
	}

	switch (m.type) {
		case "hello":
			if (typeof m.protocolVersion !== "number")
				return { valid: false, error: "hello: missing protocolVersion" };
			if (typeof m.clientId !== "string") return { valid: false, error: "hello: missing clientId" };
			if (m.clientId.length === 0 || m.clientId.length > 256)
				return { valid: false, error: "hello: clientId length out of range" };
			if (typeof m.token !== "string") return { valid: false, error: "hello: missing token" };
			if (m.token.length > 16_384)
				return { valid: false, error: "hello: token too long" };
			if (m.supportedVersions !== undefined) {
				if (!Array.isArray(m.supportedVersions))
					return { valid: false, error: "hello: supportedVersions must be array" };
				if (m.supportedVersions.length > 32)
					return { valid: false, error: "hello: supportedVersions too long" };
			}
			break;

		case "resume":
			if (typeof m.since !== "string") return { valid: false, error: "resume: missing since" };
			break;

		case "ops":
			if (!Array.isArray(m.ops)) return { valid: false, error: "ops: missing ops array" };
			if (typeof m.token !== "string") return { valid: false, error: "ops: missing token" };
			if (m.ops.length > MAX_OPS_ARRAY)
				return { valid: false, error: `ops: array length ${m.ops.length} exceeds ${MAX_OPS_ARRAY}` };
			for (let i = 0; i < m.ops.length; i++) {
				const op = m.ops[i] as Record<string, unknown>;
				if (typeof op?.id !== "string") return { valid: false, error: `ops[${i}]: missing id` };
				if (typeof op.table !== "string")
					return { valid: false, error: `ops[${i}]: missing table` };
				if (typeof op.op !== "string" || !VALID_OP_TYPES.has(op.op))
					return { valid: false, error: `ops[${i}]: invalid op type` };
				if (typeof op.rowId !== "string")
					return { valid: false, error: `ops[${i}]: missing rowId` };
				if (typeof op.hlc !== "string") return { valid: false, error: `ops[${i}]: missing hlc` };
				// Payload shape: null OR plain object. Reject primitives, arrays,
				// and functions — downstream code assumes Record<string, unknown>.
				if (op.payload !== null && op.payload !== undefined) {
					if (
						typeof op.payload !== "object" ||
						Array.isArray(op.payload)
					) {
						return { valid: false, error: `ops[${i}]: payload must be object or null` };
					}
				}
			}
			break;

		case "sync_declare":
			if (typeof m.table !== "string")
				return { valid: false, error: "sync_declare: missing table" };
			break;

		case "load_more":
			if (typeof m.table !== "string") return { valid: false, error: "load_more: missing table" };
			if (typeof m.count !== "number" || m.count <= 0 || m.count > MAX_LOAD_MORE_COUNT)
				return { valid: false, error: "load_more: invalid count" };
			break;

		case "unsync":
			if (typeof m.table !== "string") return { valid: false, error: "unsync: missing table" };
			break;

		case "auth":
			if (typeof m.token !== "string") return { valid: false, error: "auth: missing token" };
			break;

		case "ephemeral":
			if (typeof m.key !== "string") return { valid: false, error: "ephemeral: missing key" };
			if (typeof m.data !== "object" || m.data == null)
				return { valid: false, error: "ephemeral: missing data" };
			break;

		case "bootstrap":
			// No required fields beyond type
			break;
	}

	return { valid: true, message: m as unknown as ClientMessage };
}
