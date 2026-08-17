import { runStorageAdapterSuite } from "./storage-adapter-suite.ts";
import { createSqliteStorage } from "../../../src/server/storage/sqlite.ts";

runStorageAdapterSuite("SQLite (bun:sqlite)", () => createSqliteStorage());
