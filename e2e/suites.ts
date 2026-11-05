/** Each suite needs one server. Performance and large-file checks run separately from functional E2E. */
const bench = {
  command: "pnpm --filter vastgrid-bench build && pnpm --filter vastgrid-bench preview",
  url: "http://127.0.0.1:5181",
};
// Vite's development server, with React's development build: Strict Mode mounts twice only there.
const benchDev = { command: "pnpm --filter vastgrid-bench dev", url: "http://127.0.0.1:5180" };
const files = {
  command: "pnpm --filter vastgrid-files-example build && pnpm --filter vastgrid-files-example preview",
  url: "http://127.0.0.1:5183",
};

export const suites = {
  grid: { tests: ["grid", "editing"], server: bench },
  strict: { tests: ["strict"], server: benchDev },
  files: {
    tests: ["cells", "checked", "column-menu", "find", "format", "formulas", "panels", "totals"],
    server: files,
  },
  mcp: {
    tests: ["mcp"],
    server: {
      command: "pnpm --filter vastgrid-mcp build && vpx packages/mcp/host/serve.ts .data/mcp-e2e 5184",
      url: "http://127.0.0.1:5184",
    },
  },
  cli: {
    tests: ["cli"],
    server: {
      command:
        "pnpm --filter vastgrid-cli build && node packages/cli/dist/cli.js --no-open --save --port 5186 .data/cli-e2e",
      env: { VASTGRID_TOKEN: "e2e-token-0123456789" },
      url: "http://127.0.0.1:5186",
    },
  },
  open: {
    tests: ["open"],
    server: {
      // Vite keeps the built site's preview in the foreground.
      command:
        "pnpm --filter vastgrid-site build && pnpm --filter vastgrid-site exec vp preview --outDir dist --host 127.0.0.1 --port 5187 --strictPort",
      url: "http://127.0.0.1:5187/open/",
    },
  },
  performance: { tests: ["budgets"], server: bench },
  large: { tests: ["files"], server: files },
  browsers: { tests: ["browsers"], server: bench },
  notebook: {
    tests: ["notebook"],
    server: {
      command: "uv run --frozen --directory packages/notebook/python python tests/e2e_server.py",
      url: "http://127.0.0.1:5188/lab",
      // Let Jupyter close its kernels and leave the temporary-directory context before Playwright exits.
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  },
} as const;

export type Suite = keyof typeof suites;
export const functionalSuites: Suite[] = ["grid", "strict", "files", "mcp", "cli", "open"];
export function isSuite(name: string): name is Suite {
  return Object.hasOwn(suites, name);
}
