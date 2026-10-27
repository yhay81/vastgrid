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
- Float32 table values and writes must already be binary32 numbers (`Math.fround(0.1)`, not `0.1`);
  `readCellText` converts typed input to them. Invalid timestamps, intervals and lone Unicode surrogates
  are rejected by the same specification checks used to write Arrow blocks. An invalid write changes
  no cells and identifies the offending value with `/updates/{index}/value`.
- `engine.handle(message)` answers a request with its response or error, with blocks in the structured
  encoding (`{ bytes }`, §8.8), and never throws; `cancel` has no answer. `engine.subscribe(listener)` listens
  to the events of §8.5: `changed` after every write.
- The engine offers what `MEMORY_CAPABILITIES` reports (§4.10): every plan of §4.1 (derive, `where`, search,
  `aggregate` with `pivot`, `having` and sort), with every function of §4.4 and every measure of §4.5,
  `summarize` and `locate`, and `write` for tables given with `editable: true` (§7.2: by row ID or by `rowKey`, every update or none, with
  `previous` checked, and a `changed` event). Written values are kept apart from the host's rows, which stay as
  they were, and a table that holds them keeps them when it is closed. Other plans fail with `invalid_plan`
  (`unsupported`) only when they name functions or members that a later version adds, `write` on other tables with `read_only`, `save` with `save_unsupported`, and `find` and
  `export` with `invalid_request` (`unknown_op`).
- Expressions are compiled once per view to functions of a row ID (§3.6, §3.7, §4.4): exact numbers are
  computed as integers at their scale, with BigInt where a number would not be exact, so a result that does not
  fit its type is null rather than rounded; floats are 64-bit, and results that are not finite are null.
  Strings compare by code point, and `lower` and `upper` map code points one by one as DuckDB 1.5 does (`İ` →
  `i`, `ß` → `ẞ`). Derived columns are computed for every row of the table, then `where` keeps the rows of the
  view; `locate` gives null for rows that it leaves out. A million rows derive a decimal product, filter by it
  and sort by it in about 0.7 seconds.
- Groups are made from the ranks of their keys, so that values equal by §3.1 make one group (every NaN, −0.0 and
  0.0) and groups come in the order of §3.9; each measure keeps its state per group, or per group and pivot
  combination. Sums of exact numbers are exact, and null when they do not fit decimal(38, s); averages come
  from the exact sum; `stddev` is Welford's sample standard deviation and `quantile` interpolates as DuckDB's
  `quantile_cont`. Approximate measures are computed exactly. A view of groups has no row IDs: `rows` answers
  `rowIds` null, `locate` finds values of a key of the view (by `rowKey`) and nothing by row ID. A million rows
  group by 1,000 keys with four measures and sort in about 0.5 seconds.
- Plans that derive, filter or group are run by a module of their own, loaded with the first such plan, so that
  pages whose plans only sort do not load it.
- Views are in the order of §3.3. Each column's values are ranked once, by a radix sort of their bits for
  values of fixed width and by code point for strings; a view is then one counting sort per sort key. A
  million floats sort in about 0.2 seconds. Intervals compare as DuckDB 1.5 compares them (`normalizeInterval`
  of `vastgrid-spec`): whole days of the time go into the days, then whole 30-day months of the days into the
  months, truncating, and the parts compare in that order.
- `locate` finds a value of `rowKey` at its first position in the view; `summarize` counts each cell of
  `ranges` × `columns` once, sums exact numbers exactly, and gives floats that are not finite as cells but
  not as numbers.

The tests run every case of the conformance corpus of [`vastgrid-spec`](../spec), check the order against a
comparison of values one pair at a time on generated tables, and check every response with `checkResponse`. The
DuckDB engine's tests compare this engine's answers with its own on a generated table and generated plans
(`packages/duckdb-engine/test/memory-engine.test.ts`).
