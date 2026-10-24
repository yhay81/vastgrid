# vastgrid-sql

[vastgrid v2](../../docs/v2-spec.md) plans as DuckDB SQL. It is a draft and is not published yet.

`compileView(checkedPlan, source)` turns a plan checked by `vastgrid-spec` into a `WITH` query that holds
the view, and `rowsQuery` and `countQuery` read it. The SQL implements the meaning of the specification
(§3), not DuckDB's defaults where they differ: blanks last in both directions, ties broken by row ID,
computations that are not finite giving null, aggregates of floats leaving out NaN and infinities. Values are
always parameters and names are always quoted. The DuckDB session's time zone must be UTC.

A pivot (§4.6) takes two steps: run `pivotQuery` to read the combinations of values, then pass them to
`compileView`.

The tests run the whole conformance corpus of `vastgrid-spec` on DuckDB 1.5.
