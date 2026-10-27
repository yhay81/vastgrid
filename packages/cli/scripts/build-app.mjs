// Builds the page of `vastgrid` (docs/cli.md): one HTML file with its script and styles inside, which the server
// serves at `/`.
import { buildHtmlPage } from "../../../scripts/build-page.mjs";

await buildHtmlPage(new URL("..", import.meta.url));
