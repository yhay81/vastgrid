---
title: MCP App
description: An MCP server whose App shows CSV, TSV, Parquet, JSON Lines and Excel files of any size in a grid inside the chat, where the agent and the person work on the same view and cells.
---

`vastgrid-mcp` is an MCP server with an [MCP App](https://github.com/modelcontextprotocol/ext-apps): an agent
opens a CSV, TSV, Parquet, JSON Lines or Excel file of any size in a grid that you see in the chat, and both of you
work on the same grid. The agent reads the grid's state and rows and applies the grid's
[commands](/reference/commands/); you scroll, sort, filter, select and edit in the grid. What one does, the other
sees. DuckDB reads the files on the server, in Node.js; the page in the host is plain JavaScript and canvas, with
no WebAssembly, no workers and no network of its own.

## Running it

Add the server to a host that shows MCP Apps (Claude Desktop, VS Code, ChatGPT, Goose and
[others](https://modelcontextprotocol.io/clients)):

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

`vastgrid-mcp [--save] <folder>…` opens the files of the folders it is given (the current folder by default) and
no others: their real location, links followed, must be inside one. `--save` lets the grids save written cells
into CSV and TSV files, keeping the bytes that were not edited; without it, written cells stay apart from the files
until the server stops. It needs Node.js 20 or later, on a platform that DuckDB's Node.js bindings support.

In the chat, ask for a file: "open sales.parquet in vastgrid and show the 20 largest orders of 2025". The agent
calls `open_grid`, and the host shows the grid under its answer.

## Tools

| Tool | Who | What it does |
| --- | --- | --- |
| `list_files` | agent | lists the table files of the folders, two folders deep |
| `open_grid` | agent, App | opens a file in a new grid, with a document to start with; its result shows the App |
| `grid_state` | agent | the document, the session, the displayed columns, the view's row count and the unsaved edits |
| `grid_rows` | agent | rows of the view as JSON values, at most 500 at once, strings cut to 1,000 characters |
| `grid_command` | agent | applies a command as the person's keys and menus do, and gives the new state |
| `vastgrid_message` | App | carries a request of the grid to the engine |
| `grid_sync` | App | keeps the App's document and session in step with the grid's, and brings the engine's events |

The commands that only the grid applies when data arrives (`view.update`, `history.push`, `history.undone`,
`history.redone`) are refused. A command that fails changes nothing and gives `invalid_command` with its reason
and path. Writing a cell is the person's sequence: `select`, `edit.begin` with the text, `edit.commit`.
`history.undo` and `history.redo` undo and redo the agent's writes and the person's alike.

## One state for both

The server keeps each grid as a store without a screen (`GridStore` of `vastgrid/core`) on a table of the DuckDB
engine, and the agent's commands go to it, exactly as the grid on screen dispatches them. The App's `DataGrid`
has a store of its own with the same document and session, and both read the same table of the engine, so the
cells one writes are the cells the other reads.

`grid_sync` joins the two states. The grid has a version, which every change of its document or session raises,
and the newer change of a part wins. Your changes go out together 250 ms after the last one, and the App waits for
the agent's changes and the engine's events in between. An App that loads again (you reload the conversation, or
scroll back to it) gets the whole state of the grid again.

## The page

The App is one HTML file with its script and styles inside, the menus and panels included: the host serves it as
a UI resource, and it loads nothing. It declares no domains, so hosts give it their default Content Security
Policy. The page is 1.2 MB, 330 KB with gzip; most of it is the MCP client of ext-apps and zod, then React and
the grid. It takes the host's theme and locale (English or Japanese).

## Not yet

- Exports: the Export menu writes the file on the server, where you cannot download it yet.
- The App is 520 pixels high and does not ask for the full screen.
- The App does not tell the agent what the person did; the agent reads it with `grid_state`.
- Grids live as long as the server: 16 at most, the least recently used going first.

[mcp-app.md](https://github.com/yhay81/vastgrid/blob/main/docs/mcp-app.md) on GitHub has the details of the
tools, the synchronization and the tests.
