# vastgrid's documents

The guides and the API reference are on [vastgrid.yhay81.com](https://vastgrid.yhay81.com). This folder holds what
the code is checked against and how it was measured.

- **Specifications.** [spec.md](spec.md): values and types, plans, the document and the session, commands, editing
  and saving, and the messages between a grid and its engine. [react.md](react.md): the React package (the store,
  the transports, `DataGrid`, the hooks, rendering, server rendering). A change to either goes with
  `vastgrid-spec` and its conformance corpus ([CONTRIBUTING.md](../CONTRIBUTING.md)).
- **The apps.** How each is built and tested: [cli.md](cli.md) (`vastgrid-cli`), [vscode.md](vscode.md) (the VS
  Code extension), [mcp-app.md](mcp-app.md) (`vastgrid-mcp`) and [notebook.md](notebook.md) (the Python package).
- **Benchmarks.** [benchmarks/views.md](benchmarks/views.md): the DuckDB engine on large files.
  [benchmarks/memory-engine.md](benchmarks/memory-engine.md): the memory engine. Both give the commands that
  measure again.
- **[Migrating from 0.1](migrating-from-0.1.md)**: every feature of 0.1 and its place in 0.2.
- **[Proposals](proposals.md)** for the open questions of the specification (§12): nested types, folding and
  collations, and dates outside the years 0001 to 9999.

The research and the design notes that led to 0.2 (in Japanese) were removed after 0.2.0-next.1; they stay in git
at [507862d](https://github.com/yhay81/vastgrid/tree/507862d/docs).
