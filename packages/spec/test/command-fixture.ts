import type { CommandContext, GridState } from "../src/index.ts";

export const COLUMNS = [
  { name: "id", type: "bigint" as const },
  { name: "name", type: "string" as const },
];

export function bigState(updates: number): GridState {
  return {
    document: { kind: "vastgrid/document", version: 2, columns: [{ name: "id", width: 80 }] },
    session: {
      kind: "vastgrid/session",
      version: 2,
      active: { row: 5, column: "name", key: { rowId: 5 } },
      checked: { mode: "include", keys: [{ rowId: 1 }] },
      detail: { open: true },
      history: {
        undo: [
          {
            updates: Array.from({ length: updates }, (_, row) => ({
              key: { rowId: row },
              column: "name",
              before: `a${row}`,
              after: `b${row}`,
            })),
          },
        ],
        redo: [],
      },
    },
  };
}

export function rowsContext(blocks: number): CommandContext {
  return {
    table: COLUMNS,
    revision: "r1",
    view: { columns: COLUMNS, rowCount: blocks * 256, rowIds: true },
    page: 20,
    rows: Array.from({ length: blocks }, (_, block) => ({
      start: block * 256,
      keys: Array.from({ length: 256 }, (_, offset) => ({ rowId: block * 256 + offset })),
      values: Array.from({ length: 256 }, (_, offset) => [block * 256 + offset, `n${offset}`]),
    })),
  };
}
