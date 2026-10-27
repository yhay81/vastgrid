import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
// @ts-expect-error The scripts are JavaScript without declarations.
import { compiled, compilerOptions, failures, sources } from "../../../scripts/react-compiler.mjs";

const folder = fileURLToPath(new URL("../src", import.meta.url));

test("React Compiler compiles every component and hook of the package, giving up on none (react.md §11)", () => {
  const problems: string[] = [];
  const names: string[] = [];
  for (const file of sources(folder) as string[]) {
    const events: unknown[] = [];
    transformSync(readFileSync(file, "utf8"), compilerOptions(file, events));
    problems.push(...(failures(events, relative(folder, file)) as string[]));
    names.push(...(compiled(events) as string[]));
  }
  assert.deepEqual(problems, []);
  for (const name of [
    "DataGrid",
    "GridBody",
    "AccessibleRows",
    "StaticRows",
    "StatusBar",
    "Toolbar",
    "useGridSelector",
  ]) {
    assert.ok(names.includes(name), `${name} is compiled`);
  }
});
