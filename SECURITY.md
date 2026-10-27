# Security policy

## Supported versions

Security fixes are released as a new version of every package (they are released together); earlier versions
are not patched. Use the latest version. v1 (0.1.x, with `vastgrid-core` and `vastgrid-browser`) gets no fixes:
see [From v1 to v2](docs/v2-from-v1.md).

## Reporting a vulnerability

Please do not open a public issue. Report it privately on GitHub:
[Report a vulnerability](https://github.com/yhay81/vastgrid/security/advisories/new).

Include what you can of:

- the package and its version,
- how to reproduce it: a small file, the request sent to the engine, or code,
- what an attacker gains: which files they can read or write, or which server they can stop.

English and Japanese are both fine. You should hear back within a week. Once a fix is released, a GitHub
security advisory describes the problem and credits you, unless you prefer not to be named.

## Scope

`vastgrid-duckdb` answers requests from browsers, and `vastgrid-cli`, `vastgrid-mcp`, the VS Code extension and
the notebook run it on people's computers, so most reports concern it:

- reading or writing files outside `allowedDirectories` and the engine's `tempDirectory`, through paths,
  links, encoding conversion, exports or anything else,
- SQL injection through any field of a request,
- a request that crashes the server, or that makes it hold far more memory or disk than its size calls
  for,
- error messages that reveal the server's folders or SQL.

In `vastgrid`: cell values or column names that run script or inject HTML, for example through the grid's
overlays or copying as HTML. In `vastgrid-cli`: another page or program on the computer that reaches its server,
which answers only the browser that opened its address (a token in an `HttpOnly` cookie) on 127.0.0.1.

Up to the app that uses vastgrid, and not a vulnerability in vastgrid:

- which files a client may open: `allowedDirectories` and `resolve` of `DuckDBEngine.create` decide that,
- authentication, authorization and rate limiting of the endpoint,
- requests that are slow because the file is large and that work as documented, such as sorting 100
  million rows.
