// Copies non-TypeScript assets into the packages' dist folders after `tsc -b`.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("packages/react/dist", { recursive: true });
copyFileSync("packages/react/src/styles.css", "packages/react/dist/styles.css");

mkdirSync("packages/grid/dist", { recursive: true });
copyFileSync("packages/grid/src/styles.css", "packages/grid/dist/styles.css");
