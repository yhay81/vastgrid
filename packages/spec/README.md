# vastgrid-spec

The [vastgrid v2 specification](../../docs/v2-spec.md) as code. It is a draft and is not published yet.

- **Plans** (§4): `checkPlan(plan, columns)` checks a plan against a table's columns and gives the typed tree
  that engines run, or throws a `PlanError` with the `path` and `reason` of the problem. `normalizePlan`,
  `canonicalJson` and `planHash` give a plan's normal form and hash.
- **Values** (§2): `floatText`, `textOf`, `isValueOf` and the other helpers of `values.ts` and `calendar.ts`
  follow the rules of values and their text forms.
- **State** (§5): `checkDocument` and `checkSession` check the two parts of the state, `displayedColumns`
  gives the display order, `repairDocument` fits a document to a table, and `migrateGridState` migrates v1's
  `GridState`.
- **Commands** (§6, §7): `applyCommand(state, command, context)` applies a command and gives the new state,
  the requests the core sends and the output, or throws a `CommandError`. `readCellText` reads typed text, and
  `toTsv`, `parseTsv`, `parseHtmlTable` and the others of `clipboard.ts` copy and paste.
- **Messages** (§8): `checkRequest`, `checkResponse` and `checkEvent` check messages; `encodeBlock` and
  `decodeBlock` write and read Arrow blocks; `toTextEncoding`, `frameAttached` and `readAttached` carry blocks
  on transports.
- `vastgrid-spec/conformance` reads the corpus in [`conformance/`](conformance) and runs or compares its cases
  (§10). It uses Node.js. The corpus has three parts: [`plans`](conformance/plans) for engines,
  [`commands`](conformance/commands) for cores and [`messages`](conformance/messages) for both.
- [`schema/`](schema) holds the JSON Schemas of plans, states, commands, messages and the corpus files.

Every engine runs the plan cases: [`vastgrid-sql`](../sql) runs them on DuckDB. Every core runs the command
cases: this package's `applyCommand` runs them.
