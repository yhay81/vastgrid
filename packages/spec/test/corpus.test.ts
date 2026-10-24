import assert from "node:assert/strict";
import { test } from "node:test";
import { isFailure, readCorpus } from "../src/conformance.ts";
import { checkPlan, isValueOf, LOGICAL_TYPES, PlanError } from "../src/index.ts";

const files = readCorpus();
const errorCodes = new Set(["invalid_plan", "too_many_columns", "invalid_request", "not_ready", "internal"]);

test("the corpus has files and cases", () => {
  assert.ok(files.length >= 7);
  assert.ok(files.reduce((count, file) => count + file.cases.length, 0) >= 100);
});

test("case ids are unique across the corpus", () => {
  const seen = new Set<string>();
  for (const file of files) {
    for (const item of file.cases) {
      assert.ok(!seen.has(item.id), `${item.id} appears twice`);
      seen.add(item.id);
      assert.match(item.id, /^[a-z0-9]+(\.[a-z0-9-]+)+$/, item.id);
      assert.match(item.section, /^[0-9]+(\.[0-9]+)*$/, item.id);
    }
  }
});

test("table values are values of their columns' types (§2.2)", () => {
  for (const file of files) {
    for (const [name, table] of Object.entries(file.tables)) {
      for (const column of table.columns) {
        assert.ok((LOGICAL_TYPES as readonly string[]).includes(column.type), `${file.file} ${name}.${column.name}`);
      }
      table.rows.forEach((row, index) => {
        assert.equal(row.length, table.columns.length, `${file.file} ${name} row ${index}`);
        row.forEach((value, column) => {
          assert.ok(
            isValueOf(value, table.columns[column]),
            `${file.file} ${name} row ${index}: ${JSON.stringify(value)}`,
          );
        });
      });
    }
  }
});

test("cases name their tables, and expected values fit the columns they expect", () => {
  for (const file of files) {
    for (const item of file.cases) {
      const table = file.tables[item.table];
      assert.ok(table, `${item.id}: no table ${item.table}`);
      if (isFailure(item.expect)) {
        assert.ok(errorCodes.has(item.expect.error.code), `${item.id}: ${item.expect.error.code}`);
        continue;
      }
      const expect = item.expect;
      assert.ok(expect.rowCount >= expect.rows.length, item.id);
      if (expect.rowIds) assert.equal(expect.rowIds.length, expect.rows.length, item.id);
      const width = item.read?.columns?.length ?? expect.columns?.length;
      if (width !== undefined) for (const row of expect.rows) assert.equal(row.length, width, item.id);
      if (expect.columns) {
        for (const row of expect.rows) {
          row.forEach((value, column) => {
            const type = expect.columns?.[column];
            assert.ok(type && isValueOf(value, type), `${item.id}: ${JSON.stringify(value)} for ${type?.name}`);
          });
        }
      }
    }
  }
});

test("plans that a case expects to fail validation fail with its reason and path", () => {
  for (const file of files) {
    for (const item of file.cases) {
      if (!isFailure(item.expect) || item.expect.error.code !== "invalid_plan") continue;
      const columns = file.tables[item.table].columns;
      assert.throws(
        () => checkPlan(item.plan, columns),
        (error: unknown) =>
          error instanceof PlanError &&
          (item.expect as { error: { reason?: string } }).error.reason === error.reason &&
          (item.expect as { error: { path?: string } }).error.path === error.path,
        item.id,
      );
    }
  }
});
