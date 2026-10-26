# Contributing to vastgrid

Thank you for helping. Issues and pull requests are welcome in English or Japanese. Everyone taking part
follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs.** Open an issue with the steps, the file or its shape (format, size, encoding) and your versions.
- **Security problems.** Report them privately, as described in [SECURITY.md](SECURITY.md).
- **Larger changes** (new features, changes to the protocol, new dependencies). Open an issue first, so
  that we agree on the approach before you spend time on it.
- **Small fixes** (typos, documentation, clear bugs). Send a pull request directly.

## Setup

You need Node.js 20 or later and npm. CI checks with the version in `.nvmrc`.

```sh
npm install
npm run generate -w vastgrid-playground   # sample files in examples/playground/.data, add --large for 100M rows
npm run dev                               # playground at http://127.0.0.1:5174
npm run dev -w vastgrid-site              # documentation and demo at http://localhost:4321
```

The playground and the site run the packages from their TypeScript sources (the `vastgrid-source` export
condition), so edits to them apply without building.

| Folder | Contents |
| --- | --- |
| `packages/core` | `vastgrid-core`: the protocol, `RemoteSource`, `ArraySource`, the row cache, selection and scroll models, formatting. |
| `packages/react` | `vastgrid`: the `DataGrid` component, its canvas renderer, menus and panels, and the built-in texts. |
| `packages/duckdb` | `vastgrid-duckdb`: `TableEngine`, the request handler and the benchmark. |
| `packages/browser` | `vastgrid-browser`: `BrowserSource` and its Web Worker, which read local files and Parquet URLs (HTTP Range) without a server. |
| `examples/playground` | A Vite app with a table server, for trying changes. |
| `site` | The documentation and the demo at https://vastgrid.yhay81.com (Astro Starlight), in English and Japanese. |
| `docs` | The table protocol, which the site also shows. |
| `scripts` | Build and release helpers. |

## Checks

CI runs these on every pull request; run them before you push:

```sh
npm run lint        # Biome; npm run format fixes what it can
npm run typecheck
npm test
npm run build
npm run size        # after the build: what a page loads first of v2's grid, within 100 KB with gzip
npm run build -w vastgrid-site   # when you changed the site, docs/ or the grid
```

Tests use `node:test` and live in `packages/*/test/*.test.ts`. A bug fix comes with a test that fails
without it, where the bug can be reproduced outside a browser. For changes to the DuckDB engine that may
affect speed, run `npm run bench` before and after and put both results in the pull request.

## Guidelines

- `vastgrid-core` has no dependencies and uses neither React nor Node.js APIs; keep it that way.
- A change to the protocol updates [docs/protocol.md](docs/protocol.md), `parseProtocolRequest`,
  `RemoteSource` and the DuckDB handler together.
- In `vastgrid-duckdb`, SQL is generated and values are always parameters, and files are allowed by their
  real location (links followed). Keep both.
- New texts in the grid go into `packages/react/src/messages.ts` in both English and Japanese.
- Changes that users notice get a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md), starting with
  the package name.
- Changes to the API or the features update both [README.md](README.md) and [README.ja.md](README.ja.md), and
  the matching pages of the site in `site/src/content/docs` (English) and `site/src/content/docs/ja`.
- Commit messages start with a short summary in the imperative ("Fix …", "Add …"). Larger commits list
  their changes by package in the body.

## Releasing

The four packages are released together, with one version. Before 1.0, a release that breaks
compatibility raises the minor version (0.1.x → 0.2.0), and other releases raise the patch version, which
reaches apps that depend on `^0.1.0`.

On an up-to-date `main` with a clean tree:

```sh
node scripts/release.mjs version 0.1.1
git commit -am "Release 0.1.1"
git tag -s v0.1.1 -m "vastgrid 0.1.1"
git push origin main v0.1.1
```

The first command sets the version of the four packages, the `vastgrid-core` that the others depend on and
the dependencies of the playground and the site, turns "Unreleased" in [CHANGELOG.md](CHANGELOG.md) into the
version and today's date, and updates `package-lock.json`. Look over the diff and run the checks before you commit.

The tag starts the [Release workflow](.github/workflows/release.yml). It checks that the packages and
CHANGELOG.md are at the tag's version, runs the checks, publishes `vastgrid-core`, `vastgrid-duckdb`,
`vastgrid-browser` and `vastgrid` to npm with provenance, and creates the GitHub release with the CHANGELOG.md section as its notes.
A pre-release version (`0.2.0-beta.1`) is published under the `next` tag and marked as a pre-release. If a
run fails half-way, run it again: versions already on npm are skipped.

After a release that fixes a vulnerability, publish its GitHub security advisory with the fixed versions
(see [SECURITY.md](SECURITY.md)).

### One-time setup

Only the Release workflow can publish, and it needs no npm token:

- On npmjs.com, in the settings of each of the four packages, add a trusted publisher: GitHub Actions,
  the repository `yhay81/vastgrid`, the workflow `release.yml` and the environment `npm`. Then set
  publishing access to require two-factor authentication and disallow tokens.
- On GitHub, in Settings → Environments, create `npm` and limit its deployments to tags matching `v*`.
  Required reviewers there make each release wait for an approval.

## The site

The [Site workflow](.github/workflows/site.yml) builds the site for pull requests and deploys `main` to
https://vastgrid.yhay81.com, a Cloudflare Worker with static assets (`site/wrangler.jsonc`). It needs an
API token in the `CLOUDFLARE_API_TOKEN` secret, made from Cloudflare's "Edit Cloudflare Workers" template
with `yhay81.com` in its zone resources. To deploy by hand:

```sh
npm run build -w vastgrid-site
npm run deploy -w vastgrid-site   # wrangler deploy; sign in with `npx wrangler login` first
```

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
