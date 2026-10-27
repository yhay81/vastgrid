/** Each suite needs one server. Performance and large-file checks run separately from functional E2E. */
const bench = {
  command: "npm run build -w vastgrid-bench && npm run preview -w vastgrid-bench",
  url: "http://127.0.0.1:5181",
};
// Vite's development server, with React's development build: Strict Mode mounts twice only there.
const benchDev = { command: "npm run dev -w vastgrid-bench", url: "http://127.0.0.1:5180" };
const files = {
  command: "npm run build -w vastgrid-files-example && npm run preview -w vastgrid-files-example",
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
      command: "npm run build -w vastgrid-mcp && node --import tsx packages/mcp/host/serve.ts .data/mcp-e2e 5184",
      url: "http://127.0.0.1:5184",
    },
  },
  cli: {
    tests: ["cli"],
    server: {
      command:
        "npm run build -w vastgrid-cli && node packages/cli/dist/cli.js --no-open --save --port 5186 .data/cli-e2e",
      env: { VASTGRID_TOKEN: "e2e-token-0123456789" },
      url: "http://127.0.0.1:5186",
    },
  },
  open: {
    tests: ["open"],
    server: {
      // Vite keeps the built site's preview in the foreground.
      command:
        "npm run build -w vastgrid-site && npx vite preview site --outDir dist --host 127.0.0.1 --port 5187 --strictPort",
      url: "http://127.0.0.1:5187/open/",
    },
  },
  performance: { tests: ["budgets"], server: bench },
  large: { tests: ["files"], server: files },
} as const;

export type Suite = keyof typeof suites;
export const functionalSuites: Suite[] = ["grid", "strict", "files", "mcp", "cli", "open"];
export function isSuite(name: string): name is Suite {
  return Object.hasOwn(suites, name);
}
