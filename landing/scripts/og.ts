/**
 * Renders every social card in ../og to a PNG in ../public, using the local
 * Chrome install — no headless-browser dependency in the lockfile, and the cards
 * stay editable as plain HTML rather than binaries someone has to redraw.
 *
 *   bun run og
 *
 * The cards are sized and weighed for the networks that unfurl them:
 *
 *   - 1200x630 (1.91:1) is the ratio X, Facebook, LinkedIn, Slack, Discord,
 *     Telegram, Mastodon and iMessage all render without cropping. Anything
 *     further from that ratio gets letterboxed or centre-cropped somewhere.
 *   - GitHub's repository social preview wants 1280x640, so that card is its own
 *     size rather than a crop of the site one.
 *   - WhatsApp silently falls back to a small thumbnail preview above roughly
 *     300 kB, so every card has to come in under that. Each is rendered at the
 *     largest device scale factor that still fits the budget — 2x where the
 *     artwork is flat enough, 1.5x where it isn't — which keeps the image at
 *     least 1200px wide for the networks that want a high-resolution copy.
 */

import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

interface Card {
	/** File in ../og. */
	source: string;
	/** File written to ../public. */
	out: string;
	/** CSS pixel size of the card, which its stylesheet must match exactly. */
	width: number;
	height: number;
}

const CARDS: Card[] = [
	{ source: "index.html", out: "og.png", width: 1200, height: 630 },
	{ source: "tetris.html", out: "og-tetris.png", width: 1200, height: 630 },
	{ source: "github.html", out: "og-github.png", width: 1280, height: 640 },
];

/** WhatsApp drops the large preview above this. Everything else is far looser. */
const MAX_BYTES = 300 * 1024;

/** Tried in order; the first render that fits the budget wins. */
const SCALES = [2, 1.5, 1];

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

/** Width and height straight out of the PNG's IHDR chunk. */
async function pngSize(path: string): Promise<{ width: number; height: number }> {
	const header = new DataView(await Bun.file(path).slice(0, 24).arrayBuffer());
	return { width: header.getUint32(16), height: header.getUint32(20) };
}

async function render(card: Card, scale: number, out: string): Promise<void> {
	// Chrome writes the screenshot relative to its own cwd, so render to a temp
	// name next to the output and move it into place once it exists.
	const temp = `${out}.tmp.png`;
	await rm(temp, { force: true });

	const proc = Bun.spawn(
		[
			chrome as string,
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			`--force-device-scale-factor=${scale}`,
			`--window-size=${card.width},${card.height}`,
			`--screenshot=${temp}`,
			`file://${join(ROOT, "og", card.source)}`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const code = await proc.exited;
	if (code !== 0 || !existsSync(temp)) {
		console.error(await new Response(proc.stderr).text());
		throw new Error(`${card.source}: Chrome exited with ${code}`);
	}
	await rename(temp, out);
}

let failed = false;

for (const card of CARDS) {
	const out = join(ROOT, "public", card.out);
	let size = Number.POSITIVE_INFINITY;
	let used = SCALES[0];

	for (const scale of SCALES) {
		await render(card, scale, out);
		({ size } = await Bun.file(out).stat());
		used = scale;
		if (size <= MAX_BYTES) break;
	}

	// A card whose stylesheet has drifted from its manifest entry would be
	// cropped or letterboxed by every network, so treat it as a build failure
	// rather than shipping a subtly wrong image.
	const actual = await pngSize(out);
	const expected = { width: card.width * used, height: card.height * used };
	const mismatched = actual.width !== expected.width || actual.height !== expected.height;

	const kb = `${(size / 1024).toFixed(0)} kB`;
	const dimensions = `${actual.width}x${actual.height} (${used}x of ${card.width}x${card.height})`;
	console.log(`${card.out.padEnd(16)} ${dimensions.padEnd(34)} ${kb}`);

	if (mismatched) {
		console.error(`  ✗ expected ${expected.width}x${expected.height} — check og/${card.source}`);
		failed = true;
	}
	if (size > MAX_BYTES) {
		console.error(`  ✗ over ${MAX_BYTES / 1024} kB even at ${used}x — WhatsApp will not show it`);
		failed = true;
	}
}

if (failed) process.exit(1);
console.log("\nRemember to update og:image:width / og:image:height if a scale changed.");
