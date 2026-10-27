import { createRoot } from "react-dom/client";
import { type CellActionEvent, type ColumnGroup, DataGrid, type DataGridHandle, httpTransport } from "vastgrid";
import "vastgrid/styles.css";

/**
 * A file of the server's folder in v2's grid: `?file=sales-100000000.parquet`. The DuckDB engine reads it on the
 * server (`vite.config.ts`), and the grid reads blocks of it over HTTP (docs/v2-spec.md §8.8). The end-to-end tests
 * read `window.files`; `?groups=` (JSON) names column groups, and `?links=` a column whose cells are links, whose
 * clicks go to `window.files.actions`.
 */
declare global {
  interface Window {
    files: { handle: DataGridHandle | null; actions: CellActionEvent[] };
  }
}

window.files = { handle: null, actions: [] };

const params = new URLSearchParams(location.search);
const file = params.get("file");
const groups = params.get("groups");
const columnGroups = groups ? (JSON.parse(groups) as ColumnGroup[]) : undefined;
const links = params.get("links");
const element = document.getElementById("root");
if (!element) throw new Error("There is no #root.");
const transport = httpTransport("/api", { events: "/api/events" });

createRoot(element).render(
  file ? (
    <DataGrid
      ref={(handle) => {
        window.files.handle = handle;
      }}
      transport={transport}
      table={file}
      locale="en"
      checkboxes
      columnGroups={columnGroups}
      cellAction={
        links ? (cell) => (cell.column.name === links ? { kind: "link", label: `Open ${cell.text}` } : null) : undefined
      }
      onCellAction={(event) => window.files.actions.push(event)}
      aria-label={file}
      style={{ height: "100%" }}
    />
  ) : (
    <main style={{ padding: 24 }}>
      <h1>vastgrid files</h1>
      <p>
        Open a file of the server's folder with <code>?file=</code>, such as{" "}
        <a href="?file=sales-100000000.parquet">sales-100000000.parquet</a> or{" "}
        <a href="?file=sales-10000000.csv">sales-10000000.csv</a> (made by <code>npm run bench</code>).
      </p>
    </main>
  ),
);
