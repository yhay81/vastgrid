// React Compiler over a package's sources (v2-react.md §11), for the build and for the test that checks that
// the compiler gives up on no function.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Babel's options for a source file, with the compiler's events going to `events`. */
export function compilerOptions(filename, events) {
  return {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    // Plugins run before presets: the compiler sees the components before JSX and types are removed.
    plugins: [
      [
        "babel-plugin-react-compiler",
        { target: "19", panicThreshold: "none", logger: { logEvent: (_, event) => events.push(event) } },
      ],
    ],
    presets: [["@babel/preset-react", { runtime: "automatic" }], "@babel/preset-typescript"],
  };
}

/** The `.ts` and `.tsx` files of a folder and its folders, without declarations. */
export function sources(folder) {
  const files = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) files.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

/** The functions the compiler gave up on, from its events, as text. */
export function failures(events, file) {
  return events
    .filter((event) => event.kind === "CompileError" || event.kind === "PipelineError")
    .map((event) => {
      const detail = event.detail?.options ?? event.detail ?? {};
      const line = event.fnLoc?.start?.line ?? detail.loc?.start?.line ?? "?";
      return `${file}:${line} ${detail.reason ?? event.data ?? event.kind}`;
    });
}

/** The functions the compiler compiled, from its events. */
export function compiled(events) {
  return events.filter((event) => event.kind === "CompileSuccess").map((event) => event.fnName);
}
