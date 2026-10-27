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

You need Node.js 20 or later and npm. CI checks with the version in `.nvmrc`. The notebook's Python package
needs [uv](https://docs.astral.sh/uv/).

```sh
npm install
npm run dev                       # the grid on the files of .data/bench at http://127.0.0.1:5182 (examples/files)
npm run dev -w vastgrid-site      # documentation and demo at http://localhost:4321
npm run dev -w vastgrid-bench     # the bench of the budgets at http://127.0.0.1:5180/?rows=1000000
```

The examples and the site run the packages from their TypeScript sources (the `vastgrid-source` export condition),
so edits to them apply without building. `npm run bench` writes the large files of `.data/bench` the first time.

| Folder | Contents |
| --- | --- |
| `packages/spec` | `vastgrid-spec`: the specification as code: types, plan checking, the commands of the document and the session, the message schemas and the conformance corpus. |
| `packages/sql` | `vastgrid-sql`: plans as DuckDB SQL, every value a parameter. |
| `packages/js` | `vastgrid-js`: the engine in memory, for the browser and Node.js. |
| `packages/duckdb-engine` | `vastgrid-duckdb`: the DuckDB engine for Node.js, its HTTP handler and its benches. |
| `packages/grid` | `vastgrid`: the React grid, `vastgrid/core` (the store and the transports, without React) and `vastgrid/server`. |
| `packages/cli`, `packages/mcp` | `vastgrid-cli` and `vastgrid-mcp`: a file in a grid in the browser, and in a chat as an MCP App. |
| `packages/vscode` | The VS Code extension (`vastgrid-vscode` on the Marketplace). |
| `packages/notebook` | The Python package `vastgrid` (PyPI) and the grid's module it carries. |
| `examples` | `bench` (the performance budgets) and `files` (the DuckDB engine over HTTP on a folder of files). |
| `site` | The documentation and the demo at https://vastgrid.yhay81.com (Astro Starlight), in English and Japanese. |
| `docs` | The specifications ([v2-spec.md](docs/v2-spec.md), [v2-react.md](docs/v2-react.md)), the entry points, benchmarks, and [v2-from-v1.md](docs/v2-from-v1.md) for migrating from v1. |
| `scripts` | Build and release helpers. |

## Checks

CI runs these on every pull request; run them before you push:

```sh
npm run lint        # Biome; npm run format fixes what it can
npm run typecheck
npm test
npm run build
npm run size        # after the build: what a page loads first of the grid, within 200 KB with gzip
npm run pack-check  # after the build: the packages installed from their tarballs run the READMEs' examples
npm run e2e         # Playwright and the performance budgets, when the grid or an entry point changed
npm run build -w vastgrid-site   # when you changed the site, docs/ or the grid
```

Tests use `node:test` and live in `packages/*/test/*.test.ts`. A bug fix comes with a test that fails
without it, where the bug can be reproduced outside a browser. For changes to the DuckDB engine that may
affect speed, run `npm run bench` before and after and put both results in the pull request.

`packages/duckdb-engine/test/memory-engine.test.ts` sends 300 generated plans to the memory engine and the DuckDB
engine and compares their answers. After a change to either engine or to `vastgrid-sql`, run more of them:
`VASTGRID_PLANS=3000 VASTGRID_SEED=7` with the test, and `VASTGRID_ONLY=<plan seed>` to see one plan that differs.

## Guidelines

- The specifications come first: a change to the document, the session, a command, a plan or a message
  changes [docs/v2-spec.md](docs/v2-spec.md) (or [docs/v2-react.md](docs/v2-react.md) for the React package),
  `vastgrid-spec` and its conformance corpus together, and both engines answer the corpus.
- `vastgrid-spec`, `vastgrid-js` and `vastgrid/core` use neither React nor Node.js APIs; keep it that way.
- In `vastgrid-sql` and `vastgrid-duckdb`, SQL is generated and values are always parameters, and files are
  allowed by their real location (links followed). Keep both.
- New texts in the grid go into `packages/grid/src/react/messages.ts` in both English and Japanese.
- Changes that users notice get a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md), starting with
  the package name.
- Changes to the API or the features update both [README.md](README.md) and [README.ja.md](README.ja.md), the
  package's README, and the matching pages of the site in `site/src/content/docs` (English) and
  `site/src/content/docs/ja`.
- Dependencies are pinned to exact versions released at least two weeks before they are added.
- Commit messages start with a short summary in the imperative ("Fix …", "Add …"). Larger commits list
  their changes by package in the body.

## Releasing

Every package is released together, with one version, from one tag:

| Package | Where |
| --- | --- |
| `vastgrid-spec`, `vastgrid-sql`, `vastgrid-js`, `vastgrid`, `vastgrid-duckdb`, `vastgrid-cli`, `vastgrid-mcp` | npm, in that order, each depending on the others at exactly the same version |
| `vastgrid` (Python, `packages/notebook/python`) | PyPI; a pre-release `2.0.0-next.3` is `2.0.0rc3` there |
| `vastgrid-vscode` | the VS Code Marketplace, for versions that are not pre-releases; every version's `.vsix` files are on the GitHub release |

v2 starts at 2.0.0, after v1's 0.1.x. Pre-releases are `2.0.0-next.1`, `2.0.0-next.2`, …, published under npm's
`next` tag, so that `npm install vastgrid` keeps giving the last stable version and `npm install vastgrid@next`
gives the pre-release. After 2.0.0, a release that breaks compatibility raises the major version, one that adds
features the minor version, and others the patch version.

On an up-to-date `main` with a clean tree, where CI passed:

```sh
node scripts/release.mjs version 2.0.0-next.1
git commit -am "Release 2.0.0-next.1"
git tag -s v2.0.0-next.1 -m "vastgrid 2.0.0-next.1"
git push origin main v2.0.0-next.1
```

The first command sets the version of every package (the npm packages, the extension, the Python package) and of
the vastgrid packages that the packages, the examples and the site depend on, turns "Unreleased" in
[CHANGELOG.md](CHANGELOG.md) into the version and today's date, and updates `package-lock.json`. Look over the
diff and run the checks before you commit.

The tag starts the [Release workflow](.github/workflows/release.yml). It checks that the packages and
CHANGELOG.md are at the tag's version and runs the checks; packs the npm packages and runs the READMEs' examples
from the tarballs (`scripts/pack-check.mjs`); builds the Python package and the extension for each platform; then
publishes the npm packages with provenance, the Python package to PyPI and, for a version that is not a
pre-release, the extension to the Marketplace; and creates the GitHub release with the CHANGELOG.md section as its
notes and the `.vsix` and Python files attached, marked as a pre-release for `-next` versions. If a run fails
half-way, run it again: versions already published are skipped.

### From pre-releases to 2.0.0

1. Publish `2.0.0-next.1` as above, and try it as users will: `npm install vastgrid@next vastgrid-js@next`, `npx
   vastgrid-cli@next <file>`, `npx vastgrid-mcp@next` in an MCP host, the `.vsix` from the GitHub release in VS
   Code, and `pip install --pre vastgrid` in a notebook. Fix what is found and publish `-next.2`, and so on.
2. When a pre-release has had no fix for a while, release the same commit's code as `2.0.0`: `node
   scripts/release.mjs version 2.0.0`, which moves "Unreleased" to `## 2.0.0`. Move the notes of the
   pre-releases' sections into it first, so that the 2.0.0 notes say everything since v1, and set the status of
   [v2-spec.md](docs/v2-spec.md) and [v2-react.md](docs/v2-react.md) from draft to 2.0.
3. After 2.0.0 is on npm, mark v1's packages that v2 has no package for as deprecated, pointing at the
   migration guide:

   ```sh
   npm deprecate vastgrid-core "vastgrid 2 replaces vastgrid-core: see https://github.com/yhay81/vastgrid/blob/main/docs/v2-from-v1.md"
   npm deprecate vastgrid-browser "vastgrid 2 replaces vastgrid-browser with vastgrid-js: see https://github.com/yhay81/vastgrid/blob/main/docs/v2-from-v1.md"
   npm deprecate "vastgrid-duckdb@<2" "vastgrid-duckdb 2 is the DuckDB engine of vastgrid 2: see https://github.com/yhay81/vastgrid/blob/main/docs/v2-from-v1.md"
   ```

   v1's `vastgrid` and `vastgrid-duckdb` 0.1.x stay installable; their names continue at 2.0.0.

After a release that fixes a vulnerability, publish its GitHub security advisory with the fixed versions
(see [SECURITY.md](SECURITY.md)).

### One-time setup

Only the Release workflow can publish, and npm and PyPI need no token:

- On npmjs.com, for each of the seven packages, add a trusted publisher: GitHub Actions, the repository
  `yhay81/vastgrid`, the workflow `release.yml` and the environment `npm`. Then set publishing access to
  require two-factor authentication and disallow tokens. A package that is not on npm yet (`vastgrid-spec`,
  `vastgrid-sql`, `vastgrid-js`, `vastgrid-cli`, `vastgrid-mcp`) has no settings until it exists: publish its
  first pre-release by hand from the workflow's `packages` artifact (`npm publish <file>.tgz --access public
  --tag next`, signed in with two-factor authentication), then add its trusted publisher. The workflow skips
  versions that are already on npm, so it can then be run again for the others.
- On PyPI, add a pending trusted publisher for the project `vastgrid`: the repository `yhay81/vastgrid`, the
  workflow `release.yml` and the environment `pypi`.
- On the VS Code Marketplace, the publisher `yhay81`; a Personal Access Token of Azure DevOps with the
  Marketplace's Manage scope goes in the `VSCE_PAT` secret of the `vscode` environment.
- On GitHub, in Settings → Environments, create `npm`, `pypi` and `vscode`, and limit their deployments to tags
  matching `v*`. Required reviewers there make each release wait for an approval.

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
