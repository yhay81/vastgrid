# vastgrid

A canvas data grid for tables of any size: an npm workspace in TypeScript on Node.js 24. CONTRIBUTING.md has
the checks and the rules for a change (protocol, messages, CHANGELOG, both READMEs); read its Guidelines
before such a change.

## Map

- `packages/spec` (vastgrid-spec: types, plan checking, commands, schemas, conformance corpus), `packages/sql`
  (vastgrid-sql: plans as DuckDB SQL), `packages/js` (vastgrid-js: the engine in memory), `packages/duckdb-engine`
  (vastgrid-duckdb: the DuckDB engine for Node.js), `packages/grid` (vastgrid: the React grid; `vastgrid/core` without
  React). Specified by `docs/spec.md` and `docs/react.md`.
- Entry points: `packages/cli` (vastgrid-cli), `packages/mcp` (vastgrid-mcp), `packages/vscode` (the extension),
  `packages/notebook` (the Python package, with its widget).
- `examples/` (bench, files), `site/` (Astro on Cloudflare), `e2e/` (Playwright), `scripts/` (build, release,
  `pack-check.mjs`).
- Tests are `packages/*/test/*.test.ts` and import the sources (`--conditions=vastgrid-source`), so they need
  no build.

## Keep output small

- `.claude/settings.json` sets `NODE_OPTIONS=--test-reporter=dot`, so a test run prints dots and then only the
  failures. For another reporter clear it first, or Node stops with an error:
  `NODE_OPTIONS= node --test --test-reporter=spec …`.
- One file: `node --conditions=vastgrid-source --import tsx --test packages/spec/test/formula.test.ts`, and
  `--test-name-pattern='…'` for one test. `npm test` runs all of them in about 5 seconds.
- `npm run typecheck` and `npm run lint` print little when clean; add `2>&1 | head -n 40` when many errors are
  likely.
- `npm run e2e` and `npm run bench` are slow and long: run them only when the change needs them, e.g.
  `npm run e2e -- --reporter=dot 2>&1 | tail -n 40`.
- Search with `rg` or `git grep`. `grep -r` and `find` from the root walk `node_modules`, `dist` and
  `.claude/worktrees` (full checkouts with their own `node_modules`).
- `git diff --stat` before `git diff`; `git log --oneline -n 10`.

## Read large files by range

Find the lines with `rg -n`, then read only those lines.

- Over 1,000 lines: `packages/notebook/python/src/vastgrid/_engine.py` (1,400), `packages/js/src/text.ts`,
  `packages/grid/src/canvas/grid-canvas.ts`, `packages/js/src/engine.ts`, `packages/grid/src/core/store.ts`; check
  others with `wc -l` first.
- Code and tests cite the specs by section (§2.4). `rg -n '^#' docs/spec.md` is the outline of its 1,400
  lines; read only the section. The same goes for `docs/react.md`.
- `packages/spec/conformance/` holds JSON files of up to 80 KB: query them with `jq` or `rg`.
- Never read `package-lock.json` (`npm ls <name>` instead). README.md, README.ja.md, CHANGELOG.md and the
  site's reference pages are 35–50 KB: read only the section you change.
