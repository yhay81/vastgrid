import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setUp } from "../test/client.ts";

test("saving two edits in 200,000 rows keeps every other byte and takes less than 10 seconds", async (t) => {
  const context = await setUp({ saveFiles: true });
  t.after(() => context.tearDown());
  const file = path.join(context.workspace, "large.csv");
  const client = context.client;
  const lines = ["id,name,amount"];
  for (let row = 0; row < 200_000; row++) lines.push(`${row},"name ${row}",${(row * 1.25).toFixed(2)}`);
  const content = `${lines.join("\n")}\n`;
  await writeFile(file, content);
  const info = await client.open(file);
  assert.equal(info.rowCount, 200_000);
  await client.result("write", {
    table: info.table,
    revision: info.revision,
    updates: [
      { key: { rowId: 5 }, column: "name", value: "five" },
      { key: { rowId: 150_000 }, column: "amount", value: 1 },
    ],
  });
  const started = performance.now();
  assert.equal((await client.result<{ records: number }>("save", { table: info.table })).records, 2);
  const elapsed = performance.now() - started;
  const expected = content
    .replace('\n5,"name 5",6.25\n', "\n5,five,6.25\n")
    .replace('\n150000,"name 150000",187500.00\n', '\n150000,"name 150000",1.0\n');
  assert.ok((await readFile(file)).equals(Buffer.from(expected)), "only the two fields differ");
  t.diagnostic(`saving: ${Math.round(elapsed)} ms`);
  assert.ok(elapsed < 10_000, `saving took ${Math.round(elapsed)} ms`);
});
