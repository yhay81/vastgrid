# Contributing to vastgrid

Thank you for helping. Issues and pull requests are welcome in English or Japanese.

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
```

The playground runs the packages from their TypeScript sources (the `vastgrid-source` export condition), so
edits to them apply without building.

| Folder | Contents |
| --- | --- |
| `packages/core` | `vastgrid-core`: the protocol, `RemoteSource`, `ArraySource`, the row cache, selection and scroll models, formatting. |
| `packages/react` | `vastgrid`: the `DataGrid` component, its canvas renderer, menus and panels, and the built-in texts. |
| `packages/duckdb` | `vastgrid-duckdb`: `TableEngine`, the request handler and the benchmark. |
| `examples/playground` | A Vite app with a table server, for trying changes. |
| `docs` | The table protocol. |

## Checks

CI runs these on every pull request; run them before you push:

```sh
npm run lint        # Biome; npm run format fixes what it can
npm run typecheck
npm test
npm run build
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
- Changes to the API or the features update both [README.md](README.md) and [README.ja.md](README.ja.md).
- Commit messages start with a short summary in the imperative ("Fix …", "Add …"). Larger commits list
  their changes by package in the body.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
