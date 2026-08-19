import { betterAuth } from "better-auth";
import { bearer, anonymous } from "better-auth/plugins";
import { Database } from "bun:sqlite";
import { AUTH_DB_PATH, BASE_URL } from "./config.ts";

const authDb = new Database(AUTH_DB_PATH);
authDb.run("PRAGMA journal_mode = WAL");

// better-auth tables (camelCase columns)
authDb.run(`CREATE TABLE IF NOT EXISTS "user" (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	email TEXT NOT NULL UNIQUE,
	emailVerified INTEGER NOT NULL DEFAULT 0,
	image TEXT,
	isAnonymous INTEGER,
	createdAt TEXT NOT NULL DEFAULT (datetime('now')),
	updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
)`);
authDb.run(`CREATE TABLE IF NOT EXISTS "session" (
	id TEXT PRIMARY KEY,
	expiresAt TEXT NOT NULL,
	token TEXT NOT NULL UNIQUE,
	createdAt TEXT NOT NULL DEFAULT (datetime('now')),
	updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
	ipAddress TEXT,
	userAgent TEXT,
	userId TEXT NOT NULL REFERENCES "user"(id)
)`);
authDb.run(`CREATE TABLE IF NOT EXISTS "account" (
	id TEXT PRIMARY KEY,
	accountId TEXT NOT NULL,
	providerId TEXT NOT NULL,
	userId TEXT NOT NULL REFERENCES "user"(id),
	accessToken TEXT,
	refreshToken TEXT,
	idToken TEXT,
	accessTokenExpiresAt TEXT,
	refreshTokenExpiresAt TEXT,
	scope TEXT,
	password TEXT,
	createdAt TEXT NOT NULL DEFAULT (datetime('now')),
	updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
)`);
authDb.run(`CREATE TABLE IF NOT EXISTS "verification" (
	id TEXT PRIMARY KEY,
	identifier TEXT NOT NULL,
	value TEXT NOT NULL,
	expiresAt TEXT NOT NULL,
	createdAt TEXT DEFAULT (datetime('now')),
	updatedAt TEXT DEFAULT (datetime('now'))
)`);

/**
 * better-auth signs sessions with this and refuses to boot in production on its
 * built-in default. `BETTER_AUTH_SECRET` wins when it is set; otherwise the
 * demo generates one and keeps it beside the users it signs for, so sessions
 * survive a Machine restart. A wiped database starts over with a fresh secret
 * and no sessions left to invalidate.
 */
function resolveSecret(db: Database): string {
	const fromEnv = process.env.BETTER_AUTH_SECRET;
	if (fromEnv) return fromEnv;

	db.run(`CREATE TABLE IF NOT EXISTS auth_secret (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		value TEXT NOT NULL
	)`);
	const existing = db
		.query<{ value: string }, []>("SELECT value FROM auth_secret WHERE id = 1")
		.get();
	if (existing) return existing.value;

	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const generated = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	db.run("INSERT INTO auth_secret (id, value) VALUES (1, ?)", [generated]);
	return generated;
}

export const auth = betterAuth({
	baseURL: BASE_URL,
	secret: resolveSecret(authDb),
	database: authDb,
	basePath: "/api/auth",
	emailAndPassword: { enabled: true },
	plugins: [bearer(), anonymous()],
	trustedOrigins: [BASE_URL],
	// Fly's edge terminates TLS and forwards the caller's address. Without a
	// header to read it from, better-auth rate-limits every visitor into one
	// shared bucket — one busy tab would throttle everybody else.
	advanced: {
		ipAddress: { ipAddressHeaders: ["fly-client-ip", "x-forwarded-for"] },
	},
});
