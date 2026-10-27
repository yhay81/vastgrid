import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import type { AstroIntegration } from "astro";
import { defineConfig } from "astro/config";

const siteDir = fileURLToPath(new URL(".", import.meta.url));
const docsDir = join(siteDir, "../docs");

/** Copies the README's screenshot from docs/ into the site, as the image that links to the site show. */
function stageDocs(): AstroIntegration {
  return {
    name: "vastgrid-stage-docs",
    hooks: {
      "astro:config:setup": () => {
        mkdirSync(join(siteDir, "public"), { recursive: true });
        copyFileSync(join(docsDir, "images/grid.jpg"), join(siteDir, "public/og.jpg"));
      },
    },
  };
}

const site = "https://vastgrid.yhay81.com";
const serverConditions = ["vastgrid-source", "module", "node", "development|production"];

export default defineConfig({
  site,
  integrations: [
    stageDocs(),
    starlight({
      title: "vastgrid",
      description: "A canvas data grid for React that opens CSV, TSV, Parquet, JSON Lines and Excel files of any size.",
      logo: { src: "./src/assets/logo.svg" },
      favicon: "/favicon.svg",
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ja: { label: "日本語", lang: "ja" },
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/yhay81/vastgrid" }],
      editLink: { baseUrl: "https://github.com/yhay81/vastgrid/edit/main/site/" },
      head: [
        { tag: "meta", attrs: { property: "og:image", content: `${site}/og.jpg` } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
      ],
      customCss: ["./src/styles/docs.css"],
      sidebar: [
        {
          label: "Start here",
          translations: { ja: "はじめに" },
          items: [
            "getting-started",
            { label: "Live demo", translations: { ja: "デモ" }, link: "/demo/" },
            { label: "Open a file", translations: { ja: "ファイルを開く" }, link: "/open/" },
            "migrating-from-0-1",
          ],
        },
        {
          label: "Guides",
          translations: { ja: "ガイド" },
          items: [
            "guides/in-memory",
            "guides/browser",
            "guides/server",
            "guides/custom-engine",
            "guides/using-the-grid",
            "guides/state",
            "guides/editing",
            "guides/export",
            "guides/formulas",
            "guides/grouping",
            "guides/charts",
            "guides/theming",
            "guides/localization",
          ],
        },
        {
          label: "Apps",
          translations: { ja: "アプリ" },
          items: ["apps/overview", "apps/cli", "apps/vscode", "apps/mcp", "apps/notebook"],
        },
        {
          label: "Reference",
          translations: { ja: "リファレンス" },
          items: [
            "reference/data-grid",
            "reference/core",
            "reference/commands",
            "reference/engines",
            {
              label: "Specification",
              translations: { ja: "仕様" },
              link: "https://github.com/yhay81/vastgrid/blob/main/docs/spec.md",
            },
            {
              label: "Specification of the React package",
              translations: { ja: "React パッケージの仕様" },
              link: "https://github.com/yhay81/vastgrid/blob/main/docs/react.md",
            },
          ],
        },
        {
          label: "About",
          translations: { ja: "設計と性能" },
          items: [
            "about/how-it-works",
            "about/performance",
            "about/roadmap",
            {
              label: "Changelog",
              translations: { ja: "変更履歴" },
              link: "https://github.com/yhay81/vastgrid/blob/main/CHANGELOG.md",
            },
          ],
        },
      ],
    }),
    react(),
  ],
  vite: {
    // Use the TypeScript sources of the packages, as the examples do, so that the site shows the code it
    // is built with and needs no build of the packages first. The rest are Vite's default conditions, for the
    // browser and for the server environments that render the pages (they import the grid's modules too).
    resolve: { conditions: ["vastgrid-source", "module", "browser", "development|production"] },
    environments: {
      ssr: { resolve: { conditions: serverConditions } },
      prerender: { resolve: { conditions: serverConditions } },
    },
  },
});
