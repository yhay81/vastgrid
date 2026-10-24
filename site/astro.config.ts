import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import type { AstroIntegration } from "astro";
import { defineConfig } from "astro/config";

const siteDir = fileURLToPath(new URL(".", import.meta.url));
const docsDir = join(siteDir, "../docs");

/**
 * Copies what the repository keeps in docs/ into the site, so that there is one copy to edit: the protocol
 * becomes the reference page (with the front matter Starlight needs in place of its heading), and the README's
 * screenshot the image that links to the site show.
 */
function stageDocs(): AstroIntegration {
  return {
    name: "vastgrid-stage-docs",
    hooks: {
      "astro:config:setup": () => {
        const protocol = readFileSync(join(docsDir, "protocol.md"), "utf8").replace(/^# .*\n/, "");
        const page = join(siteDir, "src/content/docs/reference/protocol.md");
        const frontMatter = [
          "---",
          "title: Table protocol",
          "description: The JSON protocol between RemoteSource and a table server.",
          "editUrl: https://github.com/yhay81/vastgrid/edit/main/docs/protocol.md",
          "---",
        ];
        writeFileSync(page, `${frontMatter.join("\n")}\n${protocol}`);
        mkdirSync(join(siteDir, "public"), { recursive: true });
        copyFileSync(join(docsDir, "images/playground.jpg"), join(siteDir, "public/og.jpg"));
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
      description: "A canvas data grid for React that opens CSV, TSV, Parquet and JSON Lines files of any size.",
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
          items: ["getting-started", { label: "Live demo", translations: { ja: "デモ" }, link: "/demo/" }],
        },
        {
          label: "Guides",
          translations: { ja: "ガイド" },
          items: [
            "guides/in-memory",
            "guides/server",
            "guides/browser",
            "guides/custom-source",
            "guides/using-the-grid",
            "guides/export",
            "guides/theming",
            "guides/localization",
          ],
        },
        {
          label: "Reference",
          translations: { ja: "リファレンス" },
          items: ["reference/data-grid", "reference/table-source", "reference/duckdb", "reference/protocol"],
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
    // Use the TypeScript sources of the packages, as the playground does, so that the site shows the code it
    // is built with and needs no build of the packages first. The rest are Vite's default conditions, for the
    // browser and for the server environments that render the pages (they import the grid's modules too).
    resolve: { conditions: ["vastgrid-source", "module", "browser", "development|production"] },
    environments: {
      ssr: { resolve: { conditions: serverConditions } },
      prerender: { resolve: { conditions: serverConditions } },
    },
  },
});
