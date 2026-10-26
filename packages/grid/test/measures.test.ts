import assert from "node:assert/strict";
import { test } from "node:test";
import type { Column, GridDocument } from "vastgrid-spec";
import { measureName, measuresPlan, statisticsOf, totalMeasures } from "../src/core/measures.ts";
import { createGridStore, localTransport } from "../src/core.ts";
import { CAPABILITIES, fakeEngine, numbers, settle } from "./fake-engine.ts";

const qty: Column = { name: "qty", type: "integer" };
const city: Column = { name: "city", type: "string" };

test("statistics take the column's type and what the engine evaluates (§4.5, §4.10)", () => {
  const kinds = (column: Column, measures?: string[]) =>
    statisticsOf(column, { ...CAPABILITIES, plan: { aggregate: true }, measures }).map((item) => item.kind);
  assert.deepEqual(kinds(qty), ["rows", "values", "distinct", "min", "max", "sum", "average", "median", "stddev"]);
  assert.deepEqual(kinds(city), ["rows", "values", "distinct", "min", "max"]);
  assert.deepEqual(kinds(qty, ["count", "sum"]), ["rows", "values", "sum"]);
  assert.deepEqual(kinds(qty, ["sum"]), []);
  assert.deepEqual(statisticsOf(qty, { plan: { aggregate: false } }), []);
  assert.deepEqual(statisticsOf(qty, undefined)[7].measure, { name: "median", fn: "quantile", column: "qty", p: 0.5 });
});

test("measures are an aggregate without keys over the plan's rows; grouped plans have none", () => {
  const where = { fn: "gt", args: [{ col: "qty" }, { lit: 1 }] } as const;
  assert.deepEqual(measuresPlan({ where, sort: [{ column: "qty", direction: "asc" }] }, [{ name: "n", fn: "count" }]), {
    where,
    aggregate: { keys: [], measures: [{ name: "n", fn: "count" }] },
  });
  assert.equal(measuresPlan({ aggregate: { keys: ["qty"], measures: [] } }, []), null);
  assert.deepEqual(
    totalMeasures([
      { column: qty, setting: { name: "qty", total: { fn: "sum" } } },
      { column: city, setting: { name: "city" } },
    ]),
    [{ name: "qty", fn: "sum", column: "qty" }],
  );
  assert.equal(measureName("sum", "qty", new Set()), "sum(qty)");
  assert.equal(measureName("count", undefined, new Set(["count(*)"])), "count(*) (2)");
});

test("the store reads the totals row for the view on screen and follows its settings", async () => {
  const engine = fakeEngine(numbers(10), {
    ...CAPABILITIES,
    plan: { ...CAPABILITIES.plan, aggregate: true },
    measures: ["count", "sum", "min", "max"],
  });
  const document: GridDocument = {
    kind: "vastgrid/document",
    version: 2,
    columns: [{ name: "id", total: { fn: "sum" } }],
  };
  const store = createGridStore({ transport: localTransport(engine), table: "numbers", document });
  const disconnect = store.connect();
  store.setViewport({ top: 0, rows: 20, columns: ["id", "name", "score"] });
  for (let attempt = 0; attempt < 200 && store.getSnapshot().totals === null; attempt++) await settle(1);
  assert.deepEqual(store.getSnapshot().totals?.values, { id: 45 });
  assert.deepEqual(await store.aggregate([{ name: "most", fn: "max", column: "id" }]), {
    values: { most: 9 },
    columns: { most: { name: "most", type: "float" } },
  });

  await store.dispatch({ command: "column.total", name: "id", total: { fn: "max" } });
  for (let attempt = 0; attempt < 200 && store.getSnapshot().totals?.values.id !== 9; attempt++) await settle(1);
  assert.deepEqual(store.getSnapshot().totals?.values, { id: 9 });
  await store.dispatch({ command: "column.total", name: "id", total: null });
  assert.equal(store.getSnapshot().totals, null);
  disconnect();
});
