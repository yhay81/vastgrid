/** The bench's table: values made from the row number. */
export interface BenchColumn {
  name: string;
  type: "integer" | "string" | "float" | "date" | "boolean";
}

const BASE: BenchColumn[] = [
  { name: "id", type: "integer" },
  { name: "name", type: "string" },
  { name: "city", type: "string" },
  { name: "amount", type: "float" },
  { name: "quantity", type: "integer" },
  { name: "date", type: "date" },
  { name: "active", type: "boolean" },
  { name: "note", type: "string" },
];

const CITIES = ["Tokyo", "Osaka", "Nagoya", "Sapporo", "Fukuoka", "Kobe", "Kyoto", "Sendai"];
const NAMES = ["Aiko", "Hiro", "Mei", "Ren", "Sora", "Yuki", "Kenta", "Nao", "Riku", "Emi"];
const DAY = 86_400_000;
const START = Date.UTC(2020, 0, 1);

/** The columns: the eight of `BASE`, then repeated with a suffix up to `count`. */
export function benchColumns(count: number): BenchColumn[] {
  return Array.from({ length: count }, (_, index) => {
    const base = BASE[index % BASE.length];
    const round = Math.floor(index / BASE.length);
    return { name: round === 0 ? base.name : `${base.name}_${round}`, type: base.type };
  });
}

/** A value of a column for a row, as typed JSON (§2.2 of the specification). */
function cellValue(column: number, type: BenchColumn["type"], row: number): string | number | boolean | null {
  const mix = (row * 2_654_435_761 + column * 40_503) >>> 0;
  switch (type) {
    case "integer":
      return column % BASE.length === 0 ? row : mix % 1_000;
    case "float":
      return Math.round((mix % 1_000_000) / 10) / 100;
    case "date":
      return new Date(START + (mix % 2_000) * DAY).toISOString().slice(0, 10);
    case "boolean":
      return mix % 3 === 0;
    default:
      if (column % BASE.length === 1) return `${NAMES[mix % NAMES.length]} ${row}`;
      if (column % BASE.length === 2) return CITIES[mix % CITIES.length];
      return mix % 7 === 0 ? null : `note ${mix % 10_000}`;
  }
}

/** The table by row, for the memory engine. */
export function benchTable(rows: number, count: number) {
  const columns = benchColumns(count);
  const rowData = Array.from({ length: rows }, (_, row) =>
    columns.map((column, index) => cellValue(index, column.type, row)),
  );
  return { columns, rowData };
}
