/** The large files of the benches and the end-to-end tests, generated with DuckDB when they are missing. */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

/** The folder of the files: `.data/bench` at the top of the repository. */
export const benchDirectory = path.resolve(import.meta.dirname, "..", "..", "..", ".data", "bench");

/** The rows of the files. */
export const select = (rows: number) => `
  SELECT i AS id,
    'item-' || (i % 50000)::VARCHAR || CASE WHEN i % 7 = 0 THEN ' "special", limited' ELSE '' END AS name,
    ['Tokyo', 'Osaka', 'Nagoya', 'Fukuoka', 'Sapporo', 'Sendai', 'Hiroshima', 'Naha'][(i % 8) + 1] AS city,
    round((hash(i) % 1000000) / 100.0, 2)::DOUBLE AS price,
    (hash(i * 31) % 500)::INTEGER AS quantity,
    TIMESTAMP '2020-01-01' + to_seconds((hash(i * 17) % 157680000)::BIGINT) AS sold_at,
    (i % 3 = 0) AS member,
    CASE WHEN i % 1000 = 0 THEN 'multi' || chr(10) || 'line' WHEN i % 10 = 0 THEN NULL ELSE 'note ' || (i % 97)::VARCHAR END AS note
  FROM range(${rows}) t(i)`;

/** Makes the CSV and the Parquet file of these sizes in the folder, unless they are there already. */
export async function benchFiles(directory: string, csvRows: number, parquetRows: number) {
  await mkdir(directory, { recursive: true });
  const csv = path.join(directory, `sales-${csvRows}.csv`);
  const parquet = path.join(directory, `sales-${parquetRows}.parquet`);
  if (!existsSync(csv) || !existsSync(parquet)) {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      if (!existsSync(csv)) {
        console.error(`Generating ${csv}…`);
        await connection.run(`COPY (${select(csvRows)}) TO '${csv.replaceAll("'", "''")}' (HEADER)`);
      }
      if (!existsSync(parquet)) {
        console.error(`Generating ${parquet}…`);
        await connection.run(
          `COPY (${select(parquetRows)}) TO '${parquet.replaceAll("'", "''")}' (FORMAT parquet, COMPRESSION zstd)`,
        );
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }
  return { csv, parquet };
}
