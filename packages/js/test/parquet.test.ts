import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryEngine } from "../src/index.ts";

// Parquet files themselves are read in packages/duckdb-engine/test/memory-engine.test.ts, which writes them with
// DuckDB and compares what both engines read.

test("answers load_failed for a file that is not Parquet, and for what is not a file", async () => {
  const engine = memoryEngine({
    tables: {
      text: { parquet: new Blob(["id,name\n1,a\n"]) },
      nothing: { parquet: 42 as unknown as Blob },
    },
  });
  for (const ref of ["text", "nothing"]) {
    const response = (await engine.handle({ v: 2, id: 1, op: "open", ref })) as {
      error?: { code: string; message: string };
    };
    assert.equal(response.error?.code, "load_failed", ref);
    assert.match(response.error?.message ?? "", /\/parquet/);
  }
});
