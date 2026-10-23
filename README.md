# vastgrid

A data grid for React that opens CSV, TSV, Parquet and JSON Lines files of any size — gigabytes,
hundreds of millions of rows — and works like a spreadsheet.

[日本語](README.ja.md)

![A 100-million-row Parquet file filtered and sorted, with column statistics and a selection summary](docs/images/playground.jpg)

- **Any size.** Rows are read as you scroll, a block at a time. A 1.4 GB Parquet file with 100 million
  rows opens in 20 ms; the first rows of a 735 MB CSV appear in 0.15 s while the rest loads.
- **Fast.** Cells are drawn on a canvas: about 2 ms per frame for 1,000+ visible cells. Scrolling goes
  past the browser's element-size limit, to billions of rows.
- **A spreadsheet's way of working.** Range selection with the mouse and Excel's keyboard shortcuts,
  copy as TSV / HTML / Markdown, multi-column sort, filters with a searchable value list or conditions,
  search across all columns, find (⌘F), column statistics, and a running count, sum, average, min and
  max of the selection.
- **Bring your engine.** The grid talks to a `TableSource`. Use the DuckDB server engine for files on
  disk, `ArraySource` for data already in memory, or implement your own.
- **Safe by construction.** The DuckDB engine only reads files whose real location (links followed) is
  inside the folders you allow, and that cannot be changed while it runs. All SQL is generated; values
  are always parameters.
- **Japanese and English** built in, light and dark themes through CSS variables, ARIA grid semantics
  and full keyboard operation.

## Packages

| Package | Contents |
| --- | --- |
| [`vastgrid`](packages/react) | The `DataGrid` component (canvas renderer, interaction, menus, filters, statistics). |
| [`vastgrid-core`](packages/core) | The table protocol, row cache, selection and scroll models, formatting, `ArraySource` and `RemoteSource`. Framework-free. |
| [`vastgrid-duckdb`](packages/duckdb) | A Node.js table server backed by DuckDB, with a Fetch API request handler. |

## Quick start

### Files on a server (Node.js + DuckDB)

```sh
npm install vastgrid vastgrid-duckdb
```

```ts
// app/api/table/route.ts (Next.js) — any framework with Fetch API requests works the same way
import path from "node:path";
import { createTableHandler, TableEngine } from "vastgrid-duckdb";

const root = "/srv/data";
const engine = TableEngine.create({ allowedDirectories: [root], tempDirectory: "/tmp/vastgrid" });

export const POST = createTableHandler({
  engine: () => engine,
  // Map the client's reference to a file, refusing anything outside your folder.
  resolve: (ref) => {
    const file = path.resolve(root, ref);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Not allowed");
    return file;
  },
});
```

```tsx
"use client";
import { DataGrid, RemoteSource } from "vastgrid";
import "vastgrid/styles.css";
import { useMemo } from "react";

export function Table({ file }: { file: string }) {
  const source = useMemo(() => new RemoteSource({ endpoint: "/api/table", ref: file }), [file]);
  return (
    <div style={{ height: 600 }}>
      <DataGrid source={source} />
    </div>
  );
}
```

`vastgrid-duckdb` uses `@duckdb/node-api`, a native module: keep it out of server bundles (for Next.js,
`serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"]`) and ship the platform package
(`@duckdb/node-bindings-<platform>`, about 120 MB on macOS) with your server.

### Data in memory

```tsx
import { ArraySource, DataGrid } from "vastgrid";

const source = new ArraySource({
  columns: ["name", "born", "field"],
  rows: [
    ["Ada Lovelace", 1815, "Mathematics"],
    ["Grace Hopper", 1906, "Computer science"],
  ],
});

<DataGrid source={source} />;
```

`ArraySource` sorts, filters and summarizes on the main thread; it suits up to a few hundred thousand
rows.

## `DataGrid` props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `source` | `TableSource` | (required) | The table to show. A new source starts a new grid. |
| `locale` | `string` | the browser's language | Locale for numbers and the built-in texts: Japanese for `ja`, English otherwise. |
| `messages` | `Partial<Messages>` | | Replaces some of the built-in texts (see `en` and `ja`). |
| `rowHeight` | `number` | `--vg-row-height` or 24 | Row height in pixels. |
| `headerHeight` | `number` | `--vg-header-height` or 32 | Header height in pixels. |
| `nullText` | `string` | `""` | Text shown for null cells. |
| `frozenColumns` | `number` | `0` | Columns frozen at the left when the table opens. |
| `toolbar` | `boolean` | `true` | Shows the search box, active filters and row count. |
| `statusBar` | `boolean` | `true` | Shows the active cell and the selection summary. |
| `reloadKey` | `unknown` | | Changing it reads the table again, for example when the file changed on disk. |
| `copyLimit` | `number` | `1000000` | Cells that can be copied at once. |
| `onQueryChange` | `(query: ViewQuery) => void` | | Called when the sort, filters or search change. |
| `className`, `style` | | | Added to the root element (`.vg-root`). |
| `aria-label` | `string` | `messages.gridLabel` | The grid's name for screen readers. |

A ref gives a `DataGridHandle`: `focus()`, `reload()`, `getQuery()`, `setQuery(query)`, `goToRow(row)`, the
`controller` with the grid's state, and the canvas `renderer` (for diagnostics such as `renderer.timings()`).

```tsx
const grid = useRef<DataGridHandle>(null);

<DataGrid ref={grid} source={source} onQueryChange={(query) => saveQuery(query)} />;

// Largest values of the third column first, only rows that contain "Tokyo".
grid.current?.setQuery({ sort: [{ column: 2, direction: "desc" }], search: "Tokyo" });
```

## Performance

`npm run bench -- --csv-rows=10000000 --parquet-rows=100000000` on an Apple M2 Pro (12 threads, 32 GB),
Node.js 24, DuckDB 1.5. Times include DuckDB but not HTTP.

| Operation | Time |
| --- | ---: |
| CSV 735 MB, 10M rows: first rows readable | 143 ms |
| CSV: fully loaded (sort, filter and statistics available) | 5.3 s |
| CSV: 256 rows × 8 columns at a random position (median) | 1.8 ms |
| CSV: sort by a number / text column | 1.2 s / 1.1 s |
| CSV: filter by values (2.5M rows) / search all columns | 293 ms / 544 ms |
| CSV: column statistics (histogram, quartiles) | 117 ms |
| CSV: sum, average, min, max of 1M rows × 2 columns | 7.8 ms |
| Parquet 1.38 GB, 100M rows: open (read in place) | 20 ms |
| Parquet: 256 rows × 8 columns at a random position (median) | 24 ms |
| Parquet: sort by a number column | 1.9 s |
| Parquet sorted: 256 rows at a random position (median / 95th percentile) | 147 ms / 208 ms |

Rendering a 2280 × 1371 px viewport (56 rows × 20 columns) takes 2.0 ms per frame at the median and
3.0 ms at the 99th percentile, measured with the canvas flushed after every frame.

## How it works

```mermaid
flowchart LR
  subgraph Browser
    Grid["DataGrid<br/>canvas + DOM overlays"] --> Cache["RowCache<br/>256 × 48 blocks, prefetch,<br/>cancel, LRU"]
    Cache --> Source["TableSource"]
  end
  Source -- "RemoteSource<br/>JSON protocol" --> Handler["createTableHandler"]
  Source -. "ArraySource<br/>in memory" .-> Memory[(arrays)]
  subgraph Server["Node.js"]
    Handler --> Engine["TableEngine<br/>DuckDB"]
    Engine --> Files[(CSV · TSV · Parquet · JSON Lines)]
  end
```

- **Scrolling.** A transparent native scroller sits over the canvas, so wheel, trackpad and scrollbar
  behave natively. Browsers cap element sizes (about 16.7M px in Chromium), so `ScrollAxis` maps the
  native position to a virtual one: small movements move by the same amount, while large jumps and the
  two ends map proportionally.
- **Loading.** On every frame the grid declares the visible rows and columns. `RowCache` loads the
  missing blocks (visible first, then one screen ahead and behind), cancels requests that scrolled far
  away and drops the least recently used blocks.
- **Engine.** Delimited and JSON files become DuckDB tables in a database file of the session; the first
  1,000 rows are served from a preview while the file loads. Parquet files are read in place by row
  position. Encodings DuckDB cannot read (Shift_JIS, EUC-JP) are converted first. Sorting and filtering
  build a view: a sorted copy for tables up to 20M rows (2 ms windows), or only the order of the rows
  for larger ones (seconds instead of minutes, and a fraction of the temporary space).
- **Protocol.** `RemoteSource` speaks a small JSON protocol (see [docs/protocol.md](docs/protocol.md)).
  It reopens tables and recreates views when the server forgets them, for example after a restart.

## Keyboard

| Keys | Action |
| --- | --- |
| Arrows · Page Up/Down · Home/End | Move the active cell |
| ⌘/Ctrl + arrows · ⌘/Ctrl + Home/End | Jump to the first or last row or column |
| Shift + any of the above · Shift + click | Extend the selection |
| ⌘/Ctrl + click | Add a range |
| Tab / Enter (with Shift: backwards) | Move within the selection |
| Shift + Space · Ctrl + Space · ⌘/Ctrl + A | Select the row · the column · everything |
| ⌘/Ctrl + C · ⌘/Ctrl + Shift + C | Copy · copy with headers |
| ⌘/Ctrl + F | Find |
| Alt + ↓ | Column menu (sort, filter, statistics, freeze, hide) |
| F2 · double click | Show the full value of the cell |
| Shift + F10 · context menu key · right click | Cell menu (copy, filter to value, sort) |

## Theming

Every color, font and size is a CSS custom property on `.vg-root`, and the canvas reads them, so a few
lines of CSS restyle everything:

```css
.my-app .vg-root {
  --vg-font-family: "Inter", sans-serif;
  --vg-bg: var(--surface);
  --vg-fg: var(--text);
  --vg-accent: var(--brand);
  --vg-selection-bg: color-mix(in srgb, var(--brand) 15%, transparent);
}
```

See [`packages/react/src/styles.css`](packages/react/src/styles.css) for the full list. Colors use
`light-dark()` and follow `color-scheme`; forced-colors mode is supported.

## Development

```sh
npm install
npm run dev        # playground at http://127.0.0.1:5174 (files in examples/playground/.data)
npm run generate -w vastgrid-playground   # sample files, add --large for 100M rows
npm test
npm run lint
npm run bench
```

## Roadmap

- A browser-only engine (DuckDB-WASM or hyparquet in a worker) for apps without a server.
- Editing cells, with CSV write-back that keeps untouched rows byte for byte.
- Formula columns.
- Showing the first rows of a sort of 100M+ rows while the rest is ordered.
- Excel (`.xlsx`) input.

See [docs/research.ja.md](docs/research.ja.md) (Japanese) for the survey of existing viewers and grids
that shaped these choices.

## License

MIT
