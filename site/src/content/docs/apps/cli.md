---
title: Command line
description: Open CSV, TSV, Parquet, JSON Lines and Excel files of any size in a grid in the browser with one command, read by DuckDB on your computer.
---

`vastgrid-cli` opens CSV, TSV, Parquet, JSON Lines and Excel files of any size in a grid in the browser with one
command. DuckDB reads the files in the command, in Node.js, and the page reads blocks of rows from it over HTTP, as
the grid does from any server. Nothing leaves the computer: the server answers on 127.0.0.1 only, to the browser
that opened the address it printed.

## Running it

```sh
npx vastgrid-cli sales.parquet
npx vastgrid-cli --save data/
```

Installed, the command is `vastgrid`:

```sh
npm install -g vastgrid-cli
vastgrid sales.parquet
```

It needs Node.js 20 or later, on a platform that DuckDB's Node.js bindings support: Linux (x64 or arm64, glibc or
musl), macOS (x64 or arm64) or Windows (x64 or arm64).

```text
Usage: vastgrid [options] [<file or folder>…]

Options:
  --save       Let the page save edited cells into CSV and TSV files (⌘S or Ctrl+S).
  --port <n>   The port on 127.0.0.1; a free one by default.
  --no-open    Print the address without opening the browser.
  -h, --help   Show this help.
```

The command prints the address of the page and opens it in the browser; with `--no-open`, or when no browser
opens, open the printed address yourself. Ctrl+C stops the server and DuckDB, which deletes its folder of temporary
files (`vastgrid-cli` in the system's temporary folder). A second Ctrl+C stops without waiting; folders left by a
command that was killed are deleted by the next one.

## Files

| Format | Files |
| --- | --- |
| CSV, TSV | `.csv`, `.tsv`, `.tab`, also compressed (`.gz`, `.zst`) |
| JSON Lines, JSON | `.jsonl`, `.ndjson`, `.json`, also `.gz` |
| Parquet | `.parquet`, `.pq` |
| Excel | `.xlsx`, `.xlsm` |

- A file named opens. A folder named gives its table files, two folders deep, without hidden files and folders,
  at most 1,000. With nothing named, the current folder is used.
- The page lists the files named first, then those of the folders, by their paths from the current folder. It
  opens no other files: a file deeper in a folder named opens when its path is typed into the address, and files
  next to a file named do not open.
- DuckDB reads nothing outside the folders of the files and folders named, links followed.

## The page

The page shows the first file with the toolbar, the status bar and a check box for each row. A list above the
grid chooses another file, and the sheets of a workbook are buttons. The address keeps the file and the sheet
(`?file=…&sheet=…`), so that the browser's back and forward move between them and a page loaded again shows the
same file. Its texts follow the browser's language, English or Japanese.

Everything the grid does with an engine works: sorting, filtering, searching, grouping, pivots, formulas,
statistics, editing cells. Written cells are kept by DuckDB until the command stops, also when the page is loaded
again. Exports are downloaded by the browser.

With `--save`, ⌘S or Ctrl+S (or the toolbar's Save) writes the written cells into the CSV or TSV file they came
from, keeping every byte that holds no edited field. Without it, the command never changes a file. Parquet, JSON
Lines and Excel files are not saved; export them instead. A file changed on disk is read again, or, when it has
written cells, the grid says so and keeps them until they are discarded.

## The address and its token

The address that the command prints holds a random token. The first request with it gets an `HttpOnly`,
`SameSite=Strict` cookie for the server's port and goes on to the address without the token; every request after
it needs the cookie and is answered 401 without it. So:

- other sites open in the browser cannot read the files or change them through the server: their requests carry
  no cookie;
- other people on the computer, who can reach 127.0.0.1 too, do not know the token;
- a name of another site that points at 127.0.0.1 (DNS rebinding) is refused by the `Host` header, which must be
  `127.0.0.1` or `localhost` with the server's port.

The page's Content Security Policy lets it reach only its server (`connect-src 'self'`), load nothing else and be
in no frame. The environment variable `VASTGRID_TOKEN` sets the token (16 or more letters, digits, `-` and `_`)
for an address that stays the same. It is not an option, so that other people on the computer do not see it among
the processes' arguments.

## From another computer

The server listens on 127.0.0.1 only. To open files of a remote machine, forward the port with the same number:

```sh
ssh -L 5185:127.0.0.1:5185 server
# on the server:
npx vastgrid-cli --port 5185 --no-open /data
```

Then open the printed address on your computer.

## Not yet

- The page does not keep the view (sorts, filters, column widths) when it is loaded again.
- The page does not warn before it closes. Written cells stay in the command until it stops, and are lost then
  unless saved.

[cli.md](https://github.com/yhay81/vastgrid/blob/main/docs/cli.md) on GitHub has the details and how the command
is tested.
