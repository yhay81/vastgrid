/// <reference lib="webworker" />
/**
 * The memory engine in a Web Worker, for the page that opens a file: the page posts the file (or asks for a sample),
 * and the engine reads it here, so that reading, sorting and exporting never block the page. The file stays in the
 * browser.
 */
import { serveEngine, type WorkerLike } from "vastgrid/core";
import { memoryEngine } from "vastgrid-js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

const REGIONS = ["Tokyo", "Osaka", "Nagoya", "Sapporo", "Fukuoka", "Sendai", "Hiroshima", "Kobe"];
const PRODUCTS = ["Notebook", "Pen", "Stapler", "Desk lamp", "Chair", "Monitor", "Keyboard", "Mouse", "Cable", "Bag"];

/** A CSV file of orders made here, the same on every visit, for trying the page without a file of one's own. */
function sample(rows: number): File {
  let state = 2026;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
  const start = Date.UTC(2024, 0, 1);
  const days = Array.from({ length: 731 }, (_, day) => new Date(start + day * 86_400_000).toISOString().slice(0, 10));
  const parts = ["id,date,region,product,quantity,unit_price,paid\n"];
  let lines: string[] = [];
  for (let id = 1; id <= rows; id++) {
    const day = days[Math.floor(random() * days.length)];
    const region = REGIONS[Math.floor(random() * REGIONS.length)];
    const product = PRODUCTS[Math.floor(random() * PRODUCTS.length)];
    const quantity = 1 + Math.floor(random() * 20);
    const price = (Math.floor(random() * 50_000) / 100).toFixed(2);
    lines.push(`${id},${day},${region},${product},${quantity},${price},${random() < 0.9}`);
    if (lines.length === 10_000) {
      parts.push(`${lines.join("\n")}\n`);
      lines = [];
    }
  }
  if (lines.length > 0) parts.push(`${lines.join("\n")}\n`);
  return new File(parts, `sample-${rows}.csv`, { type: "text/csv" });
}

function start(event: MessageEvent) {
  const init = event.data as { file?: File; sample?: number } | null;
  if (!init?.file && !init?.sample) return;
  scope.removeEventListener("message", start);
  const file = init.file ?? sample(init.sample as number);
  // Parquet files are read by row groups as the grid needs them; the others are read whole when they are opened,
  // and a `.txt` file as CSV, with the separator that splits its first line best.
  const table = /\.parquet$/i.test(file.name)
    ? { parquet: file, editable: true }
    : /\.txt$/i.test(file.name)
      ? { file, format: "csv" as const, editable: true }
      : { file, editable: true };
  serveEngine(memoryEngine({ tables: { [file.name]: table } }), scope as unknown as WorkerLike);
  scope.postMessage({ ready: file.name, size: file.size });
}

scope.addEventListener("message", start);
