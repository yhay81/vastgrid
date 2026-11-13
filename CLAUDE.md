# vastgrid

A canvas data grid for tables of any size: a pnpm workspace in TypeScript on Node.js 26, with the tools of Vite+
(`vp`: Oxlint, Oxfmt, Vitest, Rolldown). CONTRIBUTING.md has the checks and the rules for a change (protocol,
messages, CHANGELOG, both READMEs); read its Guidelines before such a change.

## Map

- `packages/spec` (vastgrid-spec: types, plan checking, commands, schemas, conformance corpus), `packages/sql`
  (vastgrid-sql: plans as DuckDB SQL), `packages/js` (vastgrid-js: the engine in memory), `packages/duckdb-engine`
  (vastgrid-duckdb: the DuckDB engine for Node.js), `packages/grid` (vastgrid: the React grid; `vastgrid/core` without
  React). Specified by `docs/spec.md` and `docs/react.md`.
- Entry points: `packages/cli` (vastgrid-cli), `packages/mcp` (vastgrid-mcp), `packages/vscode` (the extension),
  `packages/notebook` (the Python package, with its widget).
- `examples/` (bench, files), `site/` (Astro on Cloudflare), `e2e/` (Playwright), `scripts/` (build, release,
  `pack-check.mjs`).
- Tests are `packages/*/test/*.test.ts`, run by Vitest (`vite.config.ts`), and import the sources (the
  `vastgrid-source` condition), so they need no build.

## Keep output small

- Vitest takes its `minimal` reporter when an agent runs it: the failures and a summary. `--reporter=verbose`
  lists every test.
- One file: `pnpm test packages/spec/test/formula.test.ts`, and `-t '…'` for the tests of a name. `pnpm test`
  runs all of them in about 20 seconds.
- `pnpm run typecheck` and `pnpm run lint` print little when clean; add `2>&1 | head -n 40` when many errors are
  likely.
- `pnpm run e2e` and `pnpm run bench` are slow and long: run them only when the change needs them, e.g.
  `pnpm run e2e grid --reporter=dot 2>&1 | tail -n 40` (a suite of `e2e/suites.ts`, then Playwright's arguments).
- Search with `rg` or `git grep`. `grep -r` and `find` from the root walk `node_modules`, `dist` and
  `.claude/worktrees` (full checkouts with their own `node_modules`).
- `git diff --stat` before `git diff`; `git log --oneline -n 10`.

## Read large files by range

Find the lines with `rg -n`, then read only those lines.

- Over 1,000 lines: `packages/js/src/text.ts`, `packages/grid/src/canvas/grid-canvas.ts` and
  `packages/spec/src/workbook.ts`; check others with `wc -l` first.
- Code and tests cite the specs by section (§2.4). `rg -n '^#' docs/spec.md` is the outline of its ~1,660
  lines; read only the section. The same goes for `docs/react.md`.
- `packages/spec/conformance/` holds JSON files of up to 80 KB: query them with `jq` or `rg`.
- Never read `pnpm-lock.yaml` (`pnpm why <name>` instead). CHANGELOG.md (~29 KB) and the site's reference pages
  (13–20 KB) are long: read only the section you change.
