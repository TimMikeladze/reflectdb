import { defineConfig } from "vite";

export default defineConfig({
	// The example imports reflectdb from source (../../src), matching the other
	// examples in this repo, so Vite has to be allowed to reach outside its root.
	server: { fs: { allow: [".."] } },
	build: { outDir: "dist", emptyOutDir: true },
});
