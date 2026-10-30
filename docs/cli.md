# vastgrid on the command line

`vastgrid` (`packages/cli`, the package `vastgrid-cli`) opens CSV, TSV, Parquet, JSON Lines and Excel files of any
size in a grid in the browser with one command. DuckDB reads the files in the command, in Node.js, and the page
reads blocks of rows from it over HTTP (docs/spec.md §8.8), as the grid does on any server. Nothing leaves the
computer: the server answers on 127.0.0.1 only, to the browser that opened the address it printed.

## Running it

Name files or folders:

```sh
npx vastgrid-cli sales.parquet
npx vastgrid-cli --save data/
```

Installed with `npm install --global vastgrid-cli`, the command is `vastgrid`. In this repository,
`npm run build` and then `node packages/cli/dist/cli.js`.

```text
Usage: vastgrid [options] [<file or folder>…]

Options:
  --save       Let the page save edited cells into CSV and TSV files (⌘S or Ctrl+S).
  --port <n>   The port on 127.0.0.1; a free one by default.
  --no-open    Print the address without opening the browser.
  -h, --help   Show this help.
```

The command prints the address of the page and opens it in the browser (`open` on macOS, `xdg-open` on Linux,
`url.dll` on Windows); with `--no-open`, or when no browser opens, open the printed address yourself. Ctrl+C stops
the server and DuckDB, which deletes its folder of temporary files (`vastgrid-cli` in the system's temporary
folder). A second Ctrl+C stops without waiting; folders left by a command that was killed are deleted by the next
one.

## Files

- A file named opens; it must be a CSV, TSV, Parquet, JSON Lines or Excel file by its name (`.csv`, `.tsv`,
  `.parquet`, `.jsonl`, `.json`, `.xlsx` and their compressed forms).
- A folder named gives its table files, two folders deep, without hidden files and folders, at most 1,000. With
  nothing named, the current folder is used.
- The page lists the files named first, then those of the folders, by their paths from the current folder. It
  opens no other files: a file deeper in a folder named opens when its path is typed into the address, and files
  next to a file named do not open. DuckDB reads nothing outside the folders of the files and folders named
  (links followed).

## The page

The page shows the first file, with the toolbar, the status bar and a check box for each row; a list above the grid
chooses another file, and the sheets of a workbook are buttons. The address keeps the file and the sheet
(`?file=…&sheet=…`), so that the browser's back and forward move between them and a page loaded again shows the same
file. The tab keeps the view of each of them, its sorts, filters, column widths, selection and scroll, and shows
it again on the way back and when the page is loaded again (`sessionStorage`). Its texts follow the browser's language (English, Japanese, Chinese, Korean, Spanish, Portuguese, French or
German).

Everything the grid does on a server works: sorting, filtering, searching, grouping, formulas, statistics. Written
cells are kept by DuckDB until the command stops, also when the page is loaded again. Exports are downloaded by the
browser.

With `--save`, ⌘S or Ctrl+S (or the toolbar's Save) writes the written cells into the CSV or TSV file they came
from, keeping every byte that holds no edited field (§7.5). Without it the command never changes a file. Parquet,
JSON Lines and Excel files are not saved. A file changed on disk is read again, or, when it has written cells, the
grid says so and keeps them until they are discarded (§7.6).

`npm run build -w vastgrid-cli` bundles the page (`packages/cli/app`) with esbuild into one HTML file,
`dist/app.html`, with its script and styles inside: 550 KB, 180 KB with gzip.

## The address and its token

The address that the command prints holds a random token. The first request with it gets an `HttpOnly`,
`SameSite=Strict` cookie of the server's port and goes on to the address without the token; every request after it
needs the cookie and is answered 401 without it. So:

- other sites open in the browser cannot read the files or change them through the server (their requests carry
  no cookie);
- other people on the computer, who can reach 127.0.0.1 too, do not know the token;
- a name of another site that points at 127.0.0.1 (DNS rebinding) is refused by the `Host` header, which must be
  `127.0.0.1` or `localhost` with the server's port.

The page's CSP lets it reach only its server (`connect-src 'self'`), load nothing else and be in no frame.
`VASTGRID_TOKEN` sets the token (16 or more letters, digits, `-` and `_`) for an address that stays the same; it is
an environment variable, not an option, so that other people on the computer do not see it among the processes'
arguments.

## Testing

- `packages/cli/test/server.test.ts` runs the server with DuckDB: the token and its cookie, the `Host` header, the
  list of files, the files that open and those that do not, paths that cannot be opened, a port in use, and the
  temporary folder after stopping.
- `e2e/cli.spec.ts` runs the built command on a folder with `--save` (`playwright.config.ts`): the printed address
  opens the page, the list and the sheets move with the address, a sort stays when the page is loaded again and
  comes back with the browser's back, a page without the token opens nothing, and a
  written cell is saved into the CSV file with the keys and exported as CSV.

## Not yet

- The server listens on 127.0.0.1 only: to use it from another computer, forward the port with the same number
  (`ssh -L 5185:127.0.0.1:5185`, with `--port 5185`).
- The page does not warn before it closes; written cells stay in the command until it stops, and are lost then
  unless saved.
