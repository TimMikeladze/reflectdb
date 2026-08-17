/**
 * Renders og/index.html to public/og.png at exactly 1200x630 using the local
 * Chrome install — no headless-browser dependency in the lockfile, and the card
 * stays editable as plain HTML rather than a binary someone has to redraw.
 *
 *   bun run og
 */

import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SOURCE = join(ROOT, "og", "index.html");
const OUT = join(ROOT, "public", "og.png");

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

const chrome = process.env.CHROME_PATH ?? CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
	console.error("No Chrome found. Set CHROME_PATH to a Chrome/Chromium binary.");
	process.exit(1);
}

// Chrome writes the screenshot relative to its own cwd, so render to a temp
// name next to the output and move it into place once it exists.
const temp = join(ROOT, "public", "og.tmp.png");
await rm(temp, { force: true });

const proc = Bun.spawn(
	[
		chrome,
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--force-device-scale-factor=2",
		"--window-size=1200,630",
		`--screenshot=${temp}`,
		`file://${SOURCE}`,
	],
	{ stdout: "pipe", stderr: "pipe" },
);

const code = await proc.exited;
if (code !== 0 || !existsSync(temp)) {
	console.error(await new Response(proc.stderr).text());
	process.exit(1);
}

await rename(temp, OUT);
const { size } = await Bun.file(OUT).stat();
console.log(`og.png written — ${(size / 1024).toFixed(0)} kB (2400x1260, 2x of 1200x630)`);
