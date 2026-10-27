# vastgrid's MCP App

`vastgrid-mcp` (`packages/mcp`) is an MCP server with an [MCP App](https://github.com/modelcontextprotocol/ext-apps):
an agent opens a CSV, TSV, Parquet, JSON Lines or Excel file of any size in a grid that the person sees in the
chat, and both work on the same grid. The agent reads the grid's state and rows and applies the commands of the
specification (docs/spec.md §6); the person scrolls, sorts, filters, selects and edits in the grid. What one
does, the other sees. DuckDB reads the files on the server, in Node.js; the page in the host is plain JavaScript
and canvas, with no WebAssembly, no workers and no network of its own.

## Running it

Add the server to a host that shows MCP Apps (Claude Desktop, VS Code, ChatGPT, Goose, and others; see the
[clients](https://modelcontextprotocol.io/clients)):

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

Before 0.2.0 is released, the pre-release is `vastgrid-mcp@next`. From this repository, `npm install` and `npm run
build`, then the command `node` with the arguments `/path/to/vastgrid/packages/mcp/dist/cli.js /path/to/data`.

`vastgrid-mcp [--save] <folder>…` opens the files of the folders it is given (the current folder by default) and no
others: their real location, links followed, must be inside one. `--save` lets the grids save written cells into
CSV and TSV files (§7.5); without it, written cells stay apart from the files until the server stops.

In the chat, ask for a file: "open sales.parquet in vastgrid and show the 20 largest orders of 2025". The agent
calls `open_grid`, and the host shows the grid under its answer.

## Tools

| Tool | Who | What it does |
| --- | --- | --- |
| `list_files` | agent | lists the table files of the folders, two folders deep |
| `open_grid` | agent, App | opens a file in a new grid, with a document to start with (§5.1); its result shows the App |
| `grid_state` | agent | the document, the session (§5.2), the displayed columns, the view's row count and the unsaved edits |
| `grid_rows` | agent | rows of the view as JSON values (§2.2), at most 500 at once, strings cut to 1,000 code points |
| `grid_command` | agent | applies a command of §6 as the person's keys and menus do, and gives the new state |
| `vastgrid_message` | App | carries a request of §8 to the engine (§8.8) |
| `grid_sync` | App | keeps the App's document and session in step with the grid's, and brings the engine's events |

The commands that only the core applies (§6.7: `view.update`, `history.push`, `history.undone`, `history.redone`)
are refused. A command that fails changes nothing and gives `invalid_command` with its reason and path (§6.1).
Writing a cell is the person's sequence: `select`, `edit.begin` with the text, `edit.commit`; `history.undo` and
`history.redo` undo and redo the agent's writes and the person's alike.

## One state for both

The server keeps each grid as a store without a screen (`GridStore` of `vastgrid/core`, §4 of
react.md) on a table of the DuckDB engine: the agent's commands go to it, exactly as the grid on screen
dispatches them. The App's `DataGrid` has a store of its own with the same document and session, controlled
(§5.2 of react.md), and reads its rows through `vastgrid_message`. Both stores read the same loaded table of the
engine, so cells that one writes are cells that the other reads.

`grid_sync` joins the two states. The grid has a version, which every change of its document or session raises,
and remembers for each part who changed it last: the agent or an App (each App names itself with a random
`client`). An App calls `grid_sync` with the version it has:

- with the parts that the person changed, which the grid takes, unless the agent or another App changed that part
  since the App's version: the newer change wins and comes back to the App, which shows it;
- without parts, to wait (20 seconds at most) for a change of the agent or another App, or for an event.

The answer has the grid's version, the parts that the App does not have, and the engine's events (§8.5) for the
tables that the App opened, which its store needs to follow writes and loading; tool calls carry no events, so the
App's transport gives them to its store from there. Commands that a store applies by itself (§6.7, when a view is
read) are not sent: each store applies them to its own state. The person's changes go out together 250 ms after
the last one.

An App that loads again (the person reloads the conversation, or scrolls back to it) starts from version −1 and
gets the whole state of the grid. An App whose server lost the grid (it started again) opens the file again with
the document it shows.

The engine's requests are numbered by each client (§8.1). The server gives the requests of every client (each App,
each `grid_rows` and the grid's own store) ids that are unique in the engine and gives the answers the client's ids
back, so that a `cancel` of one client never stops another's request.

An App that stops asking (its conversation was closed) is forgotten after a while, and the tables it opened in the
engine are closed; so are those of every App of a grid that closes (the least recently used of 16).

## The page

`npm run build -w vastgrid-mcp` bundles the App (`packages/mcp/app`) with esbuild into one HTML file,
`dist/app.html`, with its script and styles inside, the menus and panels that the grid loads when they open
included: a host serves the page as a UI resource and the page loads nothing. It declares no domains (`csp` with
empty `connectDomains` and `resourceDomains`), so hosts give it their default CSP, in which WebAssembly does not
run. The page is 1.2 MB, 330 KB with gzip; most of it is ext-apps' MCP client and zod (600 KB), then React and the
grid.

The App takes the host's theme and locale (English or Japanese).

## Testing

- `packages/mcp/test/server.test.ts` runs the tools through an MCP client, with an App's store on
  `vastgrid_message` and `grid_sync`: the agent's sort, selection and column settings reaching the App, the
  person's selection, filter, search, sort and hidden columns reaching the agent, an App that loads again, writes
  and undo, saving into the file, conflicts, and ids. `packages/mcp/test/grids.test.ts` checks that an App's
  `cancel` stops its own request only, and that the tables of Apps that stopped asking are closed.
- `e2e/mcp.spec.ts` runs the built server over stdio behind a test host (`packages/mcp/host/serve.ts`), which
  serves the page in a frame with `sandbox="allow-scripts"` and MCP Apps' default CSP and connects it with
  ext-apps' `AppBridge`, as hosts do; `POST /restart` starts the server again, and the App opens the file again as
  the person saw it. `node --import tsx packages/mcp/host/serve.ts <folder> [port]` starts it by hand:
  `http://127.0.0.1:5184/?file=orders.csv`.
- By hand in VS Code 1.142.0, with the server in a folder's `.vscode/mcp.json` (`"servers": { "vastgrid": { "type":
  "stdio", "command": "node", "args": ["/path/to/vastgrid/packages/mcp/dist/cli.js", "--save",
  "${workspaceFolder}"] } }`) and the chat's Local agent: a CSV file of 100,000 rows opens in the App under VS Code's
  CSP, the agent sorts it with `grid_command` and reads it with `grid_state` and `grid_rows`, the App shows the sort,
  and a click on a header sorts the App's grid. The chat's Copilot CLI agent ran the tools but did not show the App.

## Not yet

- Exports: the export menu writes the file on the server, where the person cannot download it yet (ext-apps'
  `downloadFile` would carry it).
- The App is 520 pixels high and does not ask for the full screen.
- The App does not tell the agent what the person did (`updateModelContext`); the agent reads it with
  `grid_state`.
- Grids live as long as the server: 16 at most, the least recently used going first.
