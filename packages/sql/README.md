# vastgrid-sql

The plans of [vastgrid](https://www.npmjs.com/package/vastgrid) as DuckDB SQL: the meaning of the
[specification](https://github.com/yhay81/vastgrid/blob/main/docs/v2-spec.md) in SQL, with every value as a
parameter. [`vastgrid-duckdb`](https://www.npmjs.com/package/vastgrid-duckdb) runs its queries; use it directly to
run vastgrid's plans on a DuckDB of your own.

```sh
npm install vastgrid-sql
```

`compileView(checkedPlan, source)` turns a plan checked by [`vastgrid-spec`](https://www.npmjs.com/package/vastgrid-spec)
into a `WITH` query that holds the view, and `rowsQuery` and `countQuery` read it. The SQL implements the meaning of
the specification (§3), not DuckDB's defaults where they differ: blanks last in both directions, ties broken by row
ID, computations that are not finite giving null, aggregates of floats leaving out NaN and infinities. Values are
always parameters and names are always quoted. The DuckDB session's time zone must be UTC.

A pivot (§4.6) takes two steps: run `pivotQuery` to read the combinations of values, then pass them to
`compileView`.

The tests run the whole conformance corpus of `vastgrid-spec` on DuckDB 2.0.
