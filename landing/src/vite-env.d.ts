/// <reference types="vite/client" />

interface ImportMetaEnv {
	/**
	 * Public API key for the presence demo on this page. The landing page is a
	 * static bundle, so this key ships to every visitor by design — it is scoped
	 * to a throwaway project with its own connection and rate ceilings, and is
	 * revocable without touching anything else. Unset simply turns the live
	 * cursors off; the card falls back to a static illustration.
	 */
	readonly VITE_PRESENCE_KEY?: string;
	/** Points the demo at a local presence service during development. */
	readonly VITE_PRESENCE_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
