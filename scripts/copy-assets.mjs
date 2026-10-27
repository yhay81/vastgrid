// Copies non-TypeScript assets into the packages' dist folders after `tsc -b`.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("packages/grid/dist", { recursive: true });
copyFileSync("packages/grid/src/styles.css", "packages/grid/dist/styles.css");
