# vastgrid-mcp

An MCP server with an [MCP App](https://github.com/modelcontextprotocol/ext-apps): an agent opens a CSV, TSV,
Parquet, JSON Lines or Excel file of any size in a grid that the person sees in the chat, and both work on the same
grid. The agent reads the grid's state and rows and applies the same commands as the person's keys and menus; the
person scrolls, sorts, filters, selects and edits. What one does, the other sees. DuckDB reads the files on the
server, in Node.js.

## Running it

Add the server to a host that shows MCP Apps (Claude Desktop, VS Code, ChatGPT, Goose and
[others](https://modelcontextprotocol.io/clients)), with the folders whose files it may open:

```json
{
  "mcpServers": {
    "vastgrid": {
      "command": "npx",
      "args": ["-y", "vastgrid-mcp", "/path/to/data"]
    }
  }
}
```

Before 0.2.0 is released, name the prerelease: `vastgrid-mcp@next`. In VS Code, the same goes into `.vscode/mcp.json`
as `"servers": { "vastgrid": { "type": "stdio", "command": "npx", "args": [...] } }`.

```text
Usage: vastgrid-mcp [--save] <folder>…
```

The server opens the files of the folders it is given (the current folder by default) and no others: their real
location, links followed, must be inside one. `--save` lets the grids save edited cells into CSV and TSV files,
rewriting only the edited fields and keeping every other byte; without it, edited cells stay apart from the files
until the server stops.

In the chat, ask for a file: "open sales.parquet in vastgrid and show the 20 largest orders of 2025". The agent
calls `open_grid`, and the host shows the grid under its answer.

## Tools

| Tool | Who | What it does |
| --- | --- | --- |
| `list_files` | agent | lists the table files of the folders, two folders deep |
| `open_grid` | agent, App | opens a file in a new grid, with a view to start with; its result shows the App |
| `grid_state` | agent | the view, the selection, the displayed columns, the row count and the unsaved edits |
| `grid_rows` | agent | rows of the view as JSON values, at most 500 at once |
| `grid_command` | agent | applies a command of the grid (sort, filter, group, select, edit, undo, save, export, …) and gives the new state |
| `vastgrid_message` | App | carries the grid's requests to the engine |
| `grid_sync` | App | keeps the App's view and selection in step with the agent's |

Writing a cell is the person's sequence: `select`, `edit.begin` with the text, `edit.commit`; `history.undo` and
`history.redo` undo and redo the agent's writes and the person's alike. A command that fails changes nothing and
says why.

The App is one HTML file, plain JavaScript and canvas with no WebAssembly, no workers and no network of its own, so
it runs under the hosts' default CSP. It takes the host's theme and locale (English or Japanese).

It needs Node.js 20 or later on a platform that DuckDB ships a binary for: Linux (x64, arm64; glibc and musl), macOS
(x64, arm64) or Windows (x64, arm64).

## Links

- [docs/mcp-app.md](https://github.com/yhay81/vastgrid/blob/main/docs/mcp-app.md): the tools, how the two states stay
  in step, and what is not done yet.
- [Where vastgrid opens files](https://vastgrid.yhay81.com/apps/overview/): the other places vastgrid opens
  files (a React component, the command line, VS Code, a notebook).
- [vastgrid.yhay81.com](https://vastgrid.yhay81.com) and [GitHub](https://github.com/yhay81/vastgrid).

## License

MIT
