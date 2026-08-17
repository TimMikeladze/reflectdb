import { betterAuth } from "better-auth";
import { bearer, anonymous } from "better-auth/plugins";
import { Database } from "bun:sqlite";

const authDb = new Database("auth.db");
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

export const auth = betterAuth({
	baseURL: "http://localhost:3003",
	database: authDb,
	basePath: "/api/auth",
	emailAndPassword: { enabled: true },
	plugins: [bearer(), anonymous()],
	trustedOrigins: ["http://localhost:3003"],
});
