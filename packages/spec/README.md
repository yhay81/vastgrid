# vastgrid-spec

The [vastgrid v2 specification](../../docs/v2-spec.md) as code. It is a draft and is not published yet.

- **Plans** (§4): `checkPlan(plan, columns)` checks a plan against a table's columns and gives the typed tree
  that engines run, or throws a `PlanError` with the `path` and `reason` of the problem. `normalizePlan`,
  `canonicalJson` and `planHash` give a plan's normal form and hash.
- **Values** (§2): `floatText`, `textOf`, `isValueOf` and the other helpers of `values.ts` and `calendar.ts`
  follow the rules of values and their text forms. Typed JSON must fit its Arrow representation: signed
  timestamp/interval counts, well-formed Unicode and already-rounded float32 numbers. `readCellText` rounds
  float32 input and rejects overflow; `encodeBlock` refuses invalid values with a `BlockValueError` and a
  `/rows/{row}/{column}` path instead of silently changing them.
- **State** (§5): `checkDocument` and `checkSession` check the two parts of the state, `displayedColumns`
  gives the display order, `repairDocument` fits a document to a table, and `migrateGridState` migrates v1's
  `GridState`.
- **Commands** (§6, §7): `applyCommand(state, command, context)` applies a command and gives the new state,
  the requests the core sends and the output, or throws a `CommandError`. The new state keeps the objects of
  what the command does not change, and a command costs nothing for the parts it does not touch (an undo
  history of a million updates is not copied when the active cell moves). `GridCommand` types every command
  and its arguments. `readCellText` reads typed text, and `toTsv`, `parseTsv`, `parseHtmlTable` and the
  others of `clipboard.ts` copy and paste.
- **Messages** (§8): `checkRequest`, `checkResponse` and `checkEvent` check messages; `encodeBlock` and
  `decodeBlock` write and read Arrow blocks, and `integerJson` and `decimalJson` give the typed JSON of a 64-bit
  integer and of an unscaled decimal (§2.2); `toTextEncoding`, `frameAttached` and `readAttached` carry blocks on
  transports.
- `vastgrid-spec/columns` reads Arrow tables of any number of record batches as columns (§2.3): `decodeColumns`
  gives each column's typed JSON by row, read when it is asked for, and the typed arrays that hold values of
  fixed width. It is a module of its own so that bundles that read only blocks do not load it.
- `vastgrid-spec/export` and `vastgrid-spec/xlsx` write the files of `export` (§8.2) from batches of rows of
  typed JSON, as streams of bytes: `writeDelimited` CSV and TSV and `writeJson` JSON as DuckDB's `COPY` writes them,
  and `writeXlsx` a workbook of one sheet (compressed by `webDeflate`, the platform's `CompressionStream`, or a
  deflate of the host's). Both engines write their files with them.
- `vastgrid-spec/workbook` reads Excel workbooks (`.xlsx`, `.xlsm`) for engines: `readWorkbook` lists the sheets,
  and `convertSheet` writes a sheet as lines of CSV with one logical type per column (by its cells and their number
  formats, in the workbook's calendar), and the notes of what a table cannot keep (merged cells, formulas without
  saved values). It reads through a `WorkbookSource` of ranges of bytes and of inflated text: `blobSource` makes
  one of a `Blob` with the platform's `DecompressionStream`, and the DuckDB engine one of a file with `node:fs` and
  `node:zlib`. Both engines read workbooks with it.
- `vastgrid-spec/conformance` reads the corpus in [`conformance/`](conformance) and runs or compares its cases
  (§10). It uses Node.js. The corpus has three parts: [`plans`](conformance/plans) for engines,
  [`commands`](conformance/commands) for cores and [`messages`](conformance/messages) for both.
- [`schema/`](schema) holds the JSON Schemas of plans, states, commands, messages and the corpus files.

Every engine runs the plan cases: [`vastgrid-sql`](../sql) runs them on DuckDB. Every core runs the command
cases: this package's `applyCommand` runs them.
