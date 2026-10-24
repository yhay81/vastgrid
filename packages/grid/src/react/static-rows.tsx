import { type Column, textOf } from "vastgrid-spec";
import { readRows, useGridSelector, useGridStore } from "./hooks.js";

/** Rows that the server sends as HTML at most. */
const MAX_ROWS = 100;

function alignOf(column: Column) {
  return column.type === "integer" || column.type === "bigint" || column.type === "decimal" || column.type === "float"
    ? "vg-static__number"
    : undefined;
}

/**
 * What the server sends in place of the canvas (§7 of v2-react.md): the first rows that the store has, from
 * `initial`, as an HTML table that is readable before any script runs; without rows, an empty body that is
 * busy. It has the size of the body, so that the canvas replaces it without moving anything.
 */
export function StaticRows({ label }: { label: string }) {
  const store = useGridStore();
  const view = useGridSelector((snapshot) => snapshot.view);
  const columns = useGridSelector((snapshot) => snapshot.displayed);
  if (!view) return <div className="vg-body" aria-busy="true" />;
  const names = columns.map((item) => item.column.name);
  // The rows that the store has from the start of the view, which `initial` gave.
  const read = readRows(store, 0, 0, Math.min(view.rowCount, MAX_ROWS), names);
  const loaded = read.findIndex((values) => values.every((value) => value === undefined));
  const rows = loaded < 0 ? read : read.slice(0, loaded);
  return (
    <div className="vg-body" aria-busy="true">
      <table className="vg-static" aria-label={label} aria-rowcount={view.rowCount + 1}>
        <thead>
          <tr>
            {columns.map((item) => (
              <th key={item.column.name} scope="col" className={alignOf(item.column)}>
                {item.setting.format?.label ?? item.column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((values, row) => (
            // Rows of a view have no other identity here: the server renders them once.
            // biome-ignore lint/suspicious/noArrayIndexKey: the rows are the view's first rows, in order.
            <tr key={row}>
              {values.map((value, index) => {
                const column = columns[index].column;
                return (
                  <td key={column.name} className={alignOf(column)}>
                    {value === undefined || value === null ? "" : (textOf(value, column) ?? "")}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
