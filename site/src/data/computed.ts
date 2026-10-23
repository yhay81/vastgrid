import {
  type CellValue,
  type ColumnSchema,
  ErrorCodes,
  type RowBlock,
  type RowRequest,
  SourceError,
  type TableInfo,
  type TableSource,
  type ViewInfo,
  type ViewQuery,
} from "vastgrid";

/** A 32-bit hash of a row and a column, so that every cell can be computed on its own. */
function hash(row: number, column: number) {
  let h = Math.imul((row % 0x100000000) ^ Math.floor(row / 0x100000000), 0x9e3779b1) ^ Math.imul(column, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

const columns: ColumnSchema[] = [
  { name: "reading", type: "bigint" },
  { name: "recorded_at", type: "timestamp" },
  { name: "sensor", type: "string" },
  { name: "site", type: "string" },
  { name: "temperature", type: "float" },
  { name: "humidity", type: "integer" },
  { name: "status", type: "string" },
  { name: "checksum", type: "string" },
];

const sites = ["Tokyo-1", "Tokyo-2", "Osaka", "Frankfurt", "Virginia", "Oregon", "São Paulo", "Sydney"];
const start = Date.UTC(1995, 0, 1) / 1000;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function timestamp(seconds: number) {
  const time = new Date(seconds * 1000);
  return (
    `${time.getUTCFullYear()}-${pad(time.getUTCMonth() + 1)}-${pad(time.getUTCDate())} ` +
    `${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())}:${pad(time.getUTCSeconds())}`
  );
}

function cell(row: number, column: number): CellValue {
  switch (column) {
    case 0:
      return row + 1;
    case 1:
      // One reading a second, from 1995 to 2026.
      return timestamp(start + row);
    case 2:
      return `sensor-${String((hash(row, 2) % 512) + 1).padStart(3, "0")}`;
    case 3:
      return sites[hash(row, 3) % sites.length];
    case 4: {
      // A daily cycle with noise, now and then missing.
      const noise = hash(row, 4);
      if (noise % 97 === 0) return null;
      const day = Math.sin(((row % 86_400) / 86_400) * 2 * Math.PI);
      return Math.round((18 + 7 * day + ((noise % 1000) / 1000) * 3) * 100) / 100;
    }
    case 5:
      return 30 + (hash(row, 5) % 60);
    case 6: {
      const roll = hash(row, 6) % 1000;
      return roll < 3 ? "error" : roll < 40 ? "warning" : "ok";
    }
    case 7:
      return hash(row, 7).toString(16).padStart(8, "0") + hash(row, 8).toString(16).padStart(8, "0");
    default:
      return null;
  }
}

/**
 * A table of a billion rows that exists only as a function: each cell is computed when the grid reads it. It
 * shows that the grid's cost depends on what is on screen, not on the size of the table, and how little a
 * `TableSource` needs: `info`, `createView` and `readRows`. It cannot sort or filter, so the grid disables them.
 */
export class ComputedSource implements TableSource {
  readonly rowCount: number;

  constructor(rowCount = 1_000_000_000) {
    this.rowCount = rowCount;
  }

  async info(): Promise<TableInfo> {
    return {
      columns,
      rowCount: this.rowCount,
      readableRows: this.rowCount,
      status: "ready",
      format: "computed",
      capabilities: {
        sort: false,
        filter: false,
        search: false,
        stats: false,
        distinct: false,
        aggregate: false,
        find: false,
        export: false,
      },
    };
  }

  async createView(query: ViewQuery): Promise<ViewInfo> {
    if (query.sort?.length || query.filters?.length || query.search) {
      throw new SourceError(ErrorCodes.invalidRequest, "This table cannot be sorted or filtered.");
    }
    return { id: null, rowCount: this.rowCount, query: {} };
  }

  async readRows(request: RowRequest): Promise<RowBlock> {
    const end = Math.min(request.end, this.rowCount);
    const start = Math.min(request.start, end);
    const values = request.columns.map((column) => {
      const list: CellValue[] = [];
      for (let row = start; row < end; row++) list.push(cell(row, column));
      return list;
    });
    return { start, end, columns: values };
  }
}
