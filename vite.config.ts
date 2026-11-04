import { defineConfig } from "vite-plus";

// Vite+'s settings for the whole workspace: Oxfmt (`vp fmt`) and Oxlint (`vp lint`), which `vp check` runs one after
// the other (`pnpm run lint`; `pnpm run format` fixes what they can). The examples and the site have their own
// vite.config.ts for their pages.
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
      // node:test's test() returns a promise that the runner awaits.
      {
        files: ["packages/*/test/**", "packages/*/perf/**", "scripts/test/**"],
        rules: { "typescript/no-floating-promises": "off" },
      },
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
});
