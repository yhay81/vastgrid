# vastgrid-cli

Open huge CSV, TSV, Parquet, JSON Lines and Excel files in a grid in the browser with one command. DuckDB reads the
files on this computer, in Node.js, and the page reads blocks of rows from it as you scroll: sort, filter, search,
group, pivot, add formulas, edit cells, export, and save edited CSV and TSV files with every byte that was not
edited kept as it is. Nothing leaves the computer.

```sh
npx vastgrid-cli sales.parquet
npx vastgrid-cli --save data/
```

Before 2.0.0 is released, run the prerelease: `npx vastgrid-cli@next sales.parquet`. Installed with
`npm install -g vastgrid-cli`, the command is `vastgrid`.

```text
Usage: vastgrid [options] [<file or folder>…]

Options:
  --save       Let the page save edited cells into CSV and TSV files (⌘S or Ctrl+S).
  --port <n>   The port on 127.0.0.1; a free one by default.
  --no-open    Print the address without opening the browser.
  -h, --help   Show this help.
```

The command prints the address of the page and opens it in the browser. Ctrl+C stops the server and DuckDB, which
deletes its temporary files.

## Files

- A file named opens when its name says it is a table: `.csv`, `.tsv`, `.tab`, `.parquet`, `.pq`, `.jsonl`,
  `.ndjson`, `.json`, `.xlsx`, `.xlsm`, and `.gz` (also `.zst` for CSV and TSV) of the text formats.
- A folder named gives its table files, two folders deep, without hidden ones, at most 1,000. With nothing named,
  the current folder is used.
- No other file opens: DuckDB reads nothing outside the folders of the files and folders named, links followed.

## The page

The page shows the first file with the toolbar, the status bar and a check box for each row; a list above the grid
chooses another file, and the sheets of a workbook are buttons. The address keeps the file and the sheet, so that
the browser's back and forward move between them. The page follows the browser's language (English or Japanese).

Edited cells are kept by DuckDB until the command stops. With `--save`, ⌘S or Ctrl+S (or the toolbar's Save)
writes them into the CSV or TSV file they came from, rewriting only the edited fields; without it, the command never
changes a file. A file changed on disk is read again, or, when it has edited cells, kept until they are discarded,
and never saved over. Exports (CSV, TSV, Parquet, JSON, Excel) are downloaded by the browser.

## Safety

The server answers on 127.0.0.1 only, and to the browser that opened the address it printed: the address holds a
random token, which becomes an `HttpOnly`, `SameSite=Strict` cookie, and every other request is refused. Requests
whose `Host` is not `127.0.0.1` or `localhost` are refused too, and the page may reach only its server.
`VASTGRID_TOKEN` (16 or more letters, digits, `-` and `_`) fixes the token, for an address that stays the same. To
use it from another computer, forward the port: `ssh -L 5185:127.0.0.1:5185`, with `--port 5185`.

It needs Node.js 20 or later on a platform that DuckDB ships a binary for: Linux (x64, arm64; glibc and musl), macOS
(x64, arm64) or Windows (x64, arm64).

## Links

- [docs/cli.md](https://github.com/yhay81/vastgrid/blob/main/docs/cli.md): the command in full.
- [docs/entries.md](https://github.com/yhay81/vastgrid/blob/main/docs/entries.md): the other places vastgrid opens
  files (a React component, VS Code, an MCP App, a notebook).
- [vastgrid.yhay81.com](https://vastgrid.yhay81.com) and [GitHub](https://github.com/yhay81/vastgrid).

## License

MIT
