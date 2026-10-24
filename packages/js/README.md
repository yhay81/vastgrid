# vastgrid-js

The JavaScript engine of [vastgrid v2](../../docs/v2-spec.md): it answers the messages of the specification
(§8) over tables in memory. It is a draft and is not published yet.

```ts
import { memoryEngine } from "vastgrid-js";

const engine = memoryEngine({
  tables: {
    orders: {
      columns: [
        { name: "id", type: "bigint" },
        { name: "price", type: "decimal", precision: 10, scale: 2 },
      ],
      rows: [
        [1, "12.50"],
        [2, "8.00"],
      ],
    },
  },
});
const info = await engine.handle({ v: 2, id: 1, op: "open", ref: "orders" });
```

- `memoryEngine({ tables })` takes the tables that `open` opens, by their `ref`: columns of §2.1 and rows of
  typed JSON values (§2.2) in row ID order. The form of a table (its columns and rows of one value per column)
  is checked when it is first opened, and its values as they are read (a column whole before it is sorted or
  summed), so that opening a table of millions of rows takes milliseconds; a table that does not follow §2 is
  answered with `load_failed` and the JSON Pointer of the place at fault. Its rows are read as they are,
  without a copy, so they must not change afterwards.
- `engine.handle(message)` answers a request with its response or error, with blocks in the structured
  encoding (`{ bytes }`, §8.8), and never throws; `cancel` has no answer. `engine.subscribe(listener)` listens
  to the events of §8.5, of which the engine sends none yet.
- The engine offers what `MEMORY_CAPABILITIES` reports (§4.10): plans that sort, `summarize` and `locate`.
  Other plans fail with `invalid_plan` (`unsupported`), `write` with `read_only`, `save` with
  `save_unsupported`, and `find` and `export` with `invalid_request` (`unknown_op`).
- Views are in the order of §3.3. Each column's values are ranked once, by a radix sort of their bits for
  values of fixed width and by code point for strings; a view is then one counting sort per sort key. A
  million floats sort in about 0.2 seconds. Intervals compare as DuckDB 1.5 compares them: whole days of the
  time go into the days, then whole 30-day months of the days into the months, truncating, and the parts
  compare in that order.
- `locate` finds a value of `rowKey` at its first position in the view; `summarize` counts each cell of
  `ranges` × `columns` once, sums exact numbers exactly, and gives floats that are not finite as cells but
  not as numbers.

The tests run every case of the conformance corpus of [`vastgrid-spec`](../spec) whose plan the engine
evaluates, check the order against a comparison of values one pair at a time on generated tables, and check
every response with `checkResponse`.
