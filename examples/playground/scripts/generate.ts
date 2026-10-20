/**
 * Writes sample tables into examples/playground/.data (or the folder given as the first argument):
 * a 1M-row CSV, a 10M-row Parquet, a 300-column Parquet, a Shift_JIS CSV, nested JSON lines and an
 * irregular CSV. Pass `--large` to also write a 100M-row Parquet (about 1.4 GB).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const target = path.resolve(
  process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? path.join(import.meta.dirname, "..", ".data"),
);
const large = process.argv.includes("--large");
await mkdir(target, { recursive: true });
const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
const sql = (text: string) => connection.run(text);
const file = (name: string) => `'${path.join(target, name).replaceAll("'", "''")}'`;

const sales = (rows: number) => `
  SELECT i + 1 AS id,
    '商品-' || (i % 50000)::VARCHAR || CASE WHEN i % 7 = 0 THEN ' "特価", 限定' ELSE '' END AS product,
    ['東京', '大阪', '名古屋', '福岡', '札幌', '仙台', '広島', '那覇'][(i % 8) + 1] AS city,
    round((hash(i) % 1000000) / 100.0, 2)::DOUBLE AS price,
    (hash(i * 31) % 500)::INTEGER AS quantity,
    TIMESTAMP '2020-01-01' + to_seconds((hash(i * 17) % 157680000)::BIGINT) AS sold_at,
    (i % 3 = 0) AS member,
    CASE WHEN i % 1000 = 0 THEN 'multi' || chr(10) || 'line note' WHEN i % 10 = 0 THEN NULL ELSE 'note ' || (i % 97)::VARCHAR END AS note
  FROM range(${rows}) t(i)`;

async function step(label: string, run: () => Promise<unknown>) {
  const started = performance.now();
  await run();
  console.log(`${label.padEnd(28)} ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

await step("sales-1m.csv", () => sql(`COPY (${sales(1_000_000)}) TO ${file("sales-1m.csv")} (HEADER)`));
await step("sales-10m.parquet", () =>
  sql(`COPY (${sales(10_000_000)}) TO ${file("sales-10m.parquet")} (FORMAT parquet, COMPRESSION zstd)`),
);
const wide = Array.from(
  { length: 300 },
  (_, index) => `round(random() * ${index + 1}, 3) AS metric_${String(index + 1).padStart(3, "0")}`,
).join(", ");
await step("wide-300.parquet", () =>
  sql(`COPY (SELECT i AS id, ${wide} FROM range(100000) t(i)) TO ${file("wide-300.parquet")} (FORMAT parquet)`),
);
await step("events.jsonl", () =>
  sql(
    `COPY (SELECT i AS id, {'user': 'u' || (i % 1000), 'tags': ['a', 'b'][1:(i % 3)]} AS payload, now() - to_minutes(i) AS at FROM range(100000) t(i)) TO ${file("events.jsonl")} (FORMAT json)`,
  ),
);
await step("japanese-shift_jis.csv", async () => {
  const lines = ["都道府県,人口,メモ"];
  const prefectures = [
    "北海道",
    "青森県",
    "岩手県",
    "宮城県",
    "秋田県",
    "山形県",
    "福島県",
    "東京都",
    "大阪府",
    "沖縄県",
  ];
  for (let index = 0; index < 10_000; index++)
    lines.push(`${prefectures[index % 10]},${(index * 7919) % 1_000_000},"備考${index}、テスト"`);
  const text = `${lines.join("\r\n")}\r\n`;
  const { execFileSync } = await import("node:child_process");
  const encoded = execFileSync("iconv", ["-f", "UTF-8", "-t", "SHIFT_JIS"], { input: text });
  await writeFile(path.join(target, "japanese-shift_jis.csv"), encoded);
});
await step("messy.csv", async () => {
  const long = "とても長い文章。".repeat(400);
  const lines = ["a,b,c", "1,2,3", "4,5", "6,7,8,9", `10,"${long}",12`, '13,"quoted ""text""",15', "16,,", "x,y,z"];
  await writeFile(path.join(target, "messy.csv"), lines.join("\n"));
});
if (large) {
  await step("sales-100m.parquet", () =>
    sql(`COPY (${sales(100_000_000)}) TO ${file("sales-100m.parquet")} (FORMAT parquet, COMPRESSION zstd)`),
  );
}
connection.closeSync();
instance.closeSync();
console.log(`Wrote samples to ${target}`);
