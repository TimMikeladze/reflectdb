/**
 * Deployment knobs for the whiteboard demo.
 *
 * Every default works locally with no environment set at all. The Fly image
 * overrides the four that have to change once the app is behind a real
 * hostname: the port it listens on, the public origin better-auth signs
 * cookies and checks origins against, and where the two SQLite files live.
 */

export const PORT = Number(process.env.PORT ?? 3003);

/**
 * The origin browsers reach this server on. better-auth rejects requests from
 * origins it does not trust, so this has to be the real scheme and host in
 * production — `https://…` there, plain `http://localhost` here.
 */
export const BASE_URL = process.env.WHITEBOARD_BASE_URL ?? `http://localhost:${PORT}`;

/** Application rows, the reflectdb op log, and the server clock. */
export const DB_PATH = process.env.WHITEBOARD_DB_PATH ?? `${import.meta.dir}/whiteboard.db`;

/** better-auth's users and sessions, kept out of the synchronized database. */
export const AUTH_DB_PATH = process.env.WHITEBOARD_AUTH_DB_PATH ?? `${import.meta.dir}/auth.db`;

/** Production serves the bundle built at image time; dev rebuilds per request. */
export const IS_PRODUCTION = process.env.NODE_ENV === "production";
