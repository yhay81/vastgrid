import { defaultServerConditions, defineConfig } from "vite-plus";

// Vite+'s settings for the whole workspace: Oxfmt (`vp fmt`) and Oxlint (`vp lint`), which `vp check` runs one after
// the other (`pnpm run lint`; `pnpm run format` fixes what they can), and Vitest (`vp test`). The examples and the
// site have their own vite.config.ts for their pages.
export default defineConfig({
  fmt: {
    printWidth: 120,
    // The manifests keep their fields in the order of their own sections.
    sortPackageJson: false,
    // The documents' Markdown is wrapped by hand; the conformance cases are written by their generator.
    ignorePatterns: ["**/*.md", "**/*.mdx", "packages/spec/conformance/**/*.json"],
  },
  lint: {
    plugins: ["oxc", "typescript", "unicorn", "react", "jsx-a11y", "import"],
    categories: { correctness: "error" },
    env: { builtin: true },
    // The Python environment of the notebook's package (packages/notebook/python) holds JupyterLab's own scripts.
    ignorePatterns: ["**/.venv/"],
    // The rules that need the types (no-floating-promises, await-thenable and others), from tsgolint.
    options: { typeAware: true },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      // Values read from DuckDB, JSON and errors are `unknown`, and String() is what makes them text.
      "typescript/no-base-to-string": "off",
      // `[...text]` counts code points, as the protocol's limits do.
      "typescript/no-misused-spread": "off",
      // Arrays are allocated at their length and then filled.
      "unicorn/no-new-array": "off",
      // A loop that changes a collection goes over a copy of it (a listener may remove itself, close() deletes), and
      // `[...text.slice(0, n)]` splits a string into code points.
      "unicorn/no-useless-spread": "off",
      // A grid drawn on a canvas has no table elements to use: it follows WAI-ARIA's grid pattern, and its menus
      // the menu pattern.
      "jsx-a11y/prefer-tag-over-role": "off",
      // aria-description is global in ARIA 1.3, which the rule's table predates.
      "jsx-a11y/role-supports-aria-props": "off",
    },
    overrides: [
      // React Compiler's rules for the grid, which React Compiler compiles (react.md §11).
      {
        files: ["packages/grid/src/**/*.{ts,tsx}"],
        rules: {
          "react/rules-of-hooks": "error",
          "react/exhaustive-deps": "warn",
          "react/static-components": "error",
          "react/use-memo": "error",
          "react/void-use-memo": "error",
          "react/preserve-manual-memoization": "error",
          "react/incompatible-library": "warn",
          "react/immutability": "error",
          "react/globals": "error",
          "react/refs": "error",
          "react/set-state-in-effect": "error",
          "react/error-boundaries": "error",
          "react/purity": "error",
          "react/set-state-in-render": "error",
          "react/unsupported-syntax": "warn",
        },
      },
    ],
  },
  // The tests import the packages' sources through the `vastgrid-source` condition of their exports, so they need no
  // build.
  ssr: { resolve: { conditions: ["vastgrid-source", ...defaultServerConditions] } },
  test: {
    // Opt in with test:coverage; ordinary local tests pay no instrumentation cost. Include unloaded UI files too.
    coverage: {
      provider: "v8",
      include: [
        "packages/*/src/**/*.{ts,tsx}",
        "packages/*/{app,host,webview}/**/*.{ts,tsx}",
        "packages/notebook/widget/**/*.{ts,tsx}",
      ],
      exclude: ["**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "lcov", "html"],
      reportOnFailure: true,
      thresholds: {
        lines: 76,
        statements: 74,
        branches: 71,
        functions: 67,
        // Package budgets keep strong logic coverage from hiding a regression in a smaller package.
        "packages/spec/src/**": { lines: 95, branches: 87, functions: 97 },
        "packages/sql/src/**": { lines: 98, branches: 91, functions: 100 },
        "packages/js/src/**": { lines: 94, branches: 87, functions: 92 },
        "packages/js/src/parquet.ts": { lines: 83, branches: 67, functions: 74 },
        "packages/duckdb-engine/src/**": { lines: 95, branches: 87, functions: 93 },
        "packages/grid/src/core/**": { lines: 93, branches: 79, functions: 88 },
      },
    },
    // The engines' tests read and write whole files: a test or a hook is stopped after a minute, not five seconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      { extends: true, test: { name: "unit", include: ["packages/*/test/*.test.ts", "scripts/test/*.test.ts"] } },
      // The performance budgets (`pnpm run test:performance`): one file at a time, with nothing else running.
      { extends: true, test: { name: "performance", include: ["packages/*/perf/*.test.ts"], fileParallelism: false } },
    ],
  },
});
