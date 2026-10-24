# vastgrid-spec

The [vastgrid v2 specification](../../docs/v2-spec.md) as code. It is a draft and is not published yet.

- `checkPlan(plan, columns)` checks a plan against a table's columns (§4.7) and gives the typed tree that
  engines run, or throws a `PlanError` with the `path` and `reason` of the problem.
- `normalizePlan`, `canonicalJson` and `planHash` give a plan's normal form and hash (§4.8).
- `floatText`, `isValueOf` and the other helpers of `values.ts` follow the rules of values (§2).
- `vastgrid-spec/conformance` reads the conformance corpus in [`conformance/`](conformance) and compares an
  engine's answers with it (§10). It uses Node.js.
- [`schema/`](schema) holds the JSON Schemas of plans, states and corpus files.

Every engine runs the corpus: [`vastgrid-sql`](../sql) runs it on DuckDB.
