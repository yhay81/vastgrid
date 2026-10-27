import type { MemoryTable } from "vastgrid-js";

type Value = MemoryTable["rows"][number][number];

/** A small, fast pseudo-random generator, so that every visitor sees the same table. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const givenNames = ["Ada", "Grace", "Alan", "Linus", "Margaret", "Emma", "Noah", "Olivia", "Liam", "Sofia", "Mateo"];
const familyNames = ["Lovelace", "Hopper", "Turing", "Hamilton", "Johnson", "García", "Müller", "Rossi", "Silva"];
const japaneseNames = [
  "佐藤 花子",
  "鈴木 一郎",
  "高橋 結衣",
  "田中 蓮",
  "伊藤 陽菜",
  "渡辺 大翔",
  "山本 さくら",
  "中村 湊",
];

const places: [city: string, country: string, weight: number][] = [
  ["東京", "Japan", 9],
  ["大阪", "Japan", 5],
  ["名古屋", "Japan", 3],
  ["福岡", "Japan", 2],
  ["札幌", "Japan", 2],
  ["New York", "United States", 6],
  ["San Francisco", "United States", 3],
  ["Chicago", "United States", 2],
  ["London", "United Kingdom", 5],
  ["Paris", "France", 4],
  ["Berlin", "Germany", 4],
  ["São Paulo", "Brazil", 3],
  ["Singapore", "Singapore", 3],
  ["Sydney", "Australia", 2],
  ["Toronto", "Canada", 2],
];

const catalog: [category: string, product: string, price: number][] = [
  ["Books", "Designing Data-Intensive Applications", 4980],
  ["Books", "The Art of Computer Programming", 25800],
  ["Books", "吾輩は猫である", 660],
  ["Electronics", "USB-C cable 2 m", 1280],
  ["Electronics", "Mechanical keyboard", 18900],
  ["Electronics", "27-inch 4K monitor", 54800],
  ["Electronics", "Noise-cancelling headphones", 39600],
  ["Home", "Pour-over coffee kettle", 7480],
  ["Home", "Desk lamp", 5980],
  ["Home", "抹茶 100 g", 2160],
  ["Outdoors", "Trail running shoes", 16500],
  ["Outdoors", "Camping stove", 8800],
  ["Toys", "Wooden puzzle", 2420],
  ["Toys", "Building blocks, 1,000 pieces", 9900],
];

const notes = [
  "Gift wrap, please.",
  "Leave at the front desk.",
  "置き配を希望します。",
  "Customer asked for the invoice by email.\nSecond line of the note.",
];

const longNote =
  "This note is long on purpose: double-click the cell or press F2 to read all of it. " +
  "Cells show one line and end with an ellipsis, the cell inspector shows the whole value, and copying " +
  "a cell copies its whole text. ".repeat(4);

export const orderColumns: MemoryTable["columns"] = [
  { name: "order_id", type: "integer" },
  { name: "ordered_at", type: "timestamp" },
  { name: "customer", type: "string" },
  { name: "city", type: "string" },
  { name: "country", type: "string" },
  { name: "category", type: "string" },
  { name: "product", type: "string" },
  { name: "quantity", type: "integer" },
  // Decimals are text with their digits (§2.2 of the specification), as DuckDB's are.
  { name: "unit_price", type: "decimal", precision: 10, scale: 2, sourceType: "DECIMAL(10,2)" },
  { name: "total", type: "decimal", precision: 12, scale: 2, sourceType: "DECIMAL(12,2)" },
  { name: "paid", type: "boolean" },
  { name: "rating", type: "integer" },
  { name: "note", type: "string" },
];

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * A table of made-up orders, generated in the browser: `rows` rows of numbers, decimals, dates, text in several
 * scripts, booleans, blanks and a few long values. The same `rows` always gives the same table.
 */
export function generateOrders(rows: number): Value[][] {
  const random = mulberry32(20261020);
  const columns: Value[][] = orderColumns.map(() => new Array<Value>(rows));
  const [
    orderId,
    orderedAt,
    customer,
    city,
    country,
    category,
    product,
    quantity,
    unitPrice,
    total,
    paid,
    rating,
    note,
  ] = columns;
  const placeTable = places.flatMap((place) => Array<(typeof places)[number]>(place[2]).fill(place));
  const start = Date.UTC(2024, 0, 1);
  // Spread the orders over two years, in order.
  const step = (2 * 365 * 86_400_000) / rows;
  for (let row = 0; row < rows; row++) {
    orderId[row] = 100_001 + row;
    const time = new Date(start + row * step + random() * step);
    orderedAt[row] =
      `${time.getUTCFullYear()}-${pad(time.getUTCMonth() + 1)}-${pad(time.getUTCDate())} ` +
      `${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())}:${pad(time.getUTCSeconds())}`;
    const place = placeTable[Math.floor(random() * placeTable.length)];
    city[row] = place[0];
    country[row] = place[1];
    customer[row] =
      place[1] === "Japan" && random() < 0.8
        ? japaneseNames[Math.floor(random() * japaneseNames.length)]
        : `${givenNames[Math.floor(random() * givenNames.length)]} ${familyNames[Math.floor(random() * familyNames.length)]}`;
    const item = catalog[Math.floor(random() * catalog.length)];
    category[row] = item[0];
    product[row] = item[1];
    const count = random() < 0.7 ? 1 : 1 + Math.floor(random() * 9);
    quantity[row] = count;
    // Prices in yen with a discount now and then, as decimals.
    const cents = Math.round(item[2] * (random() < 0.15 ? 0.8 : 1) * 100);
    unitPrice[row] = (cents / 100).toFixed(2);
    total[row] = ((cents * count) / 100).toFixed(2);
    paid[row] = random() < 0.92;
    rating[row] = random() < 0.4 ? null : 1 + Math.floor(random() ** 0.5 * 5);
    const roll = random();
    note[row] = roll < 0.001 ? longNote : roll < 0.04 ? notes[Math.floor(random() * notes.length)] : null;
  }
  return columns;
}

/** The made-up orders as a table of the memory engine, by row, whose cells can be written. */
export function ordersTable(rows: number): MemoryTable {
  const columns = generateOrders(rows);
  return {
    columns: orderColumns,
    rows: Array.from({ length: rows }, (_, row) => columns.map((values) => values[row])),
    editable: true,
  };
}
