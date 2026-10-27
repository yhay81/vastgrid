// Compiles a React package's sources with React Compiler into its dist folder, after `tsc -b` wrote the types
// (react.md §11), so that apps get the compiler's memoization without configuring it. Fails when the
// compiler gives up on any function: what ships is what the tests checked.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { transformSync } from "@babel/core";
import { compilerOptions, failures, sources } from "./react-compiler.mjs";

const pkg = process.argv[2];
if (!pkg) throw new Error("Give the package's folder, such as packages/grid.");
const problems = [];
for (const file of sources(join(pkg, "src"))) {
  const events = [];
  const name = relative(join(pkg, "src"), file);
  const result = transformSync(readFileSync(file, "utf8"), compilerOptions(file, events));
  problems.push(...failures(events, name));
  const out = join(pkg, "dist", name.replace(/\.tsx?$/, ".js"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${result.code}\n//# sourceMappingURL=${basename(out)}.map\n`);
  writeFileSync(`${out}.map`, JSON.stringify(result.map));
}
if (problems.length > 0) {
  console.error(`React Compiler gave up on:\n${problems.join("\n")}`);
  process.exit(1);
}
