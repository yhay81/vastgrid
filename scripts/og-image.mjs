// Draws the image that links to the site show, docs/images/og.jpg, at 1280 by 640 pixels (the size GitHub takes
// for a repository's social preview too): the logo, the home page's headline and the VS Code screenshot, in
// Playwright's Chromium. The site copies it to its og.jpg (site/astro.config.ts). `node scripts/og-image.mjs`
// after changing one of them.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("..", import.meta.url));
const images = path.join(root, "docs", "images");
const logo = await readFile(path.join(images, "logo.svg"), "utf8");
const screenshot = `data:image/png;base64,${(await readFile(path.join(images, "vscode.png"))).toString("base64")}`;

// The home page's colors in its dark theme (site/src/styles/landing.css).
const html = `<!doctype html>
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    position: relative; width: 1280px; height: 640px; overflow: hidden;
    background: hsl(223 30% 7.5%); color: #fff; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .sheet {
    position: absolute; inset: 0;
    background:
      linear-gradient(to right, hsl(223 15% 24% / 0.8) 1px, transparent 1px) 0 0 / 112px 100%,
      linear-gradient(to bottom, hsl(223 15% 24% / 0.8) 1px, transparent 1px) 0 0 / 100% 28px;
    mask-image: radial-gradient(ellipse 75% 95% at 25% 20%, #000 15%, transparent 75%);
  }
  .range { position: absolute; border: 2px solid #6f9df0; background: rgb(111 157 240 / 12%); opacity: 0.8; }
  .range::after {
    content: ""; position: absolute; right: -5px; bottom: -5px; width: 8px; height: 8px;
    border: 1px solid hsl(223 30% 7.5%); background: #6f9df0;
  }
  .glow {
    position: absolute; right: -260px; top: -160px; width: 1000px; height: 820px;
    background: radial-gradient(closest-side, rgb(76 130 245 / 30%), transparent);
  }
  .copy { position: absolute; left: 80px; top: 76px; width: 600px; }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 700; letter-spacing: -0.02em; }
  .brand svg { width: 50px; height: 50px; }
  h1 { margin-top: 60px; font-size: 68px; font-weight: 700; line-height: 1.04; letter-spacing: -0.04em; }
  h1 span {
    display: block; padding-bottom: 4px; color: transparent;
    background: linear-gradient(100deg, #a3c2ff 15%, #c9b6ff 85%); -webkit-background-clip: text; background-clip: text;
  }
  p { margin-top: 26px; color: hsl(222 16% 79%); font-size: 25px; line-height: 1.45; }
  .apps { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 34px; }
  .apps span {
    padding: 6px 15px; border: 1px solid hsl(223 15% 26%); border-radius: 999px;
    background: hsl(223 25% 10.5%); color: hsl(222 20% 86%); font-size: 19px;
  }
  .shot {
    position: absolute; left: 730px; top: 112px; width: 860px; border: 1px solid hsl(223 15% 32%); border-radius: 14px;
    box-shadow: 0 40px 90px -20px rgb(0 0 0 / 75%);
    transform: perspective(1800px) rotateY(-16deg) rotateX(5deg); transform-origin: left center;
  }
</style>
<div class="sheet"></div>
<div class="range" style="left: 448px; top: 28px; width: 225px; height: 57px"></div>
<div class="range" style="left: 336px; top: 560px; width: 113px; height: 29px"></div>
<div class="glow"></div>
<img class="shot" src="${screenshot}" alt="">
<div class="copy">
  <div class="brand">${logo}vastgrid</div>
  <h1>Open huge tables <span>like a spreadsheet</span></h1>
  <p>CSV, TSV, Parquet, JSON Lines and Excel files of any size, in a data grid drawn on a canvas.</p>
  <div class="apps"><span>React</span><span>VS Code</span><span>Command line</span><span>MCP Apps</span><span>Jupyter</span></div>
</div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await page.setContent(html);
  await page.screenshot({ path: path.join(images, "og.jpg"), type: "jpeg", quality: 90 });
} finally {
  await browser.close();
}
