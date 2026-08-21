import { type Plugin, defineConfig, loadEnv } from "vite";

/** The self-hosted Umami instance the site reports to unless pointed elsewhere. */
const DEFAULT_UMAMI_SCRIPT = "https://linesofcode-umami.vercel.app/script.js";

/**
 * Injects the Umami tag into index.html at build time.
 *
 * Analytics are entirely optional. With `VITE_UMAMI_WEBSITE_ID` unset — a local
 * dev server, a fork, anyone building the site themselves — nothing is injected
 * and the page ships with no third-party request at all, so the site never
 * depends on the tracker being reachable. Setting that one variable in the
 * Vercel project turns it on.
 */
function umami(env: Record<string, string>): Plugin {
	const websiteId = env.VITE_UMAMI_WEBSITE_ID?.trim();
	const src = env.VITE_UMAMI_SCRIPT_URL?.trim() || DEFAULT_UMAMI_SCRIPT;
	// Umami drops hits whose hostname is not on this list, which is what keeps
	// preview deployments and localhost out of the numbers. Unset counts every
	// hostname the bundle happens to be served from.
	const domains = env.VITE_UMAMI_DOMAINS?.trim();

	return {
		name: "reflectdb:umami",
		transformIndexHtml() {
			if (!websiteId) return [];
			return [
				{
					tag: "script",
					attrs: {
						defer: true,
						src,
						"data-website-id": websiteId,
						...(domains ? { "data-domains": domains } : {}),
					},
					injectTo: "head" as const,
				},
			];
		},
	};
}

export default defineConfig(({ mode }) => ({
	// loadEnv reads landing/.env* and, for the same prefix, the variables Vercel
	// injects into the build as process.env — which is how the production build
	// picks these up without an .env file in the repo.
	plugins: [umami(loadEnv(mode, process.cwd(), "VITE_"))],
	server: { port: 5173 },
	build: { outDir: "dist", target: "es2022" },
}));
