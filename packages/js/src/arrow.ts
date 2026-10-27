/**
 * Tables given as Arrow (docs/v2-spec.md §2.3), read by a module of their own that the engine loads with the
 * first such table, so that pages whose tables are rows do not load it.
 */
import { decodeColumns } from "vastgrid-spec/columns";
import { type CheckedTable, checkNames, TableProblem } from "./table.js";

/**
 * Checks a table given as Arrow and reads its columns: their logical types, and their values kept as Arrow holds
 * them. Throws a `TableProblem` at `/arrow` for bytes that are not an Arrow table of §2.3.
 */
export function checkArrow(bytes: unknown): CheckedTable {
  if (!(bytes instanceof Uint8Array)) {
    throw new TableProblem("/arrow", "arrow is the bytes of an Arrow IPC stream or file, in a Uint8Array.");
  }
  let decoded: ReturnType<typeof decodeColumns>;
  try {
    decoded = decodeColumns(bytes);
  } catch (error) {
    throw new TableProblem("/arrow", `The bytes are not an Arrow table of §2.3: ${(error as Error).message}`);
  }
  checkNames(decoded.columns, () => "/arrow");
  return { columns: decoded.columns, rows: null, vectors: decoded.values, rowCount: decoded.length };
}
