// Builds the App's page (docs/mcp-app.md): one HTML file with its script and styles inside, as hosts take a UI
// resource.
import { readFileSync } from "node:fs";
import { buildHtmlPage } from "../../../scripts/build-page.mjs";

const root = new URL("..", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
await buildHtmlPage(root, { VASTGRID_VERSION: JSON.stringify(version) });
