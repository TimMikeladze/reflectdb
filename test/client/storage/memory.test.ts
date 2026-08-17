import { createMemoryStorage } from "../../../src/client/storage/memory.ts";
import { runClientStorageSuite } from "./client-storage-suite.ts";

runClientStorageSuite("Memory", () => createMemoryStorage());
