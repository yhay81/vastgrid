// Draws the logo's images from docs/images/logo.svg, the one source of the logo: copies it to the site's logo
// and favicon, and renders the VS Code extension's icon, packages/vscode/media/icon.png, at 256 by 256 pixels
// (the Marketplace takes no SVG icon) in Playwright's Chromium. `node scripts/icons.mjs` after changing the logo.
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("..", import.meta.url));
const logo = path.join(root, "docs", "images", "logo.svg");
for (const copy of [
  ["site", "src", "assets", "logo.svg"],
  ["site", "public", "favicon.svg"],
]) {
  await copyFile(logo, path.join(root, ...copy));
}

const svg = (await readFile(logo, "utf8")).replace("<svg ", '<svg width="256" height="256" ');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.screenshot({ path: path.join(root, "packages", "vscode", "media", "icon.png"), omitBackground: true });
} finally {
  await browser.close();
}
