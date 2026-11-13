import assert from "node:assert/strict";
import { dateMillisecond, int32, tableFromArrays, tableToIPC, timeMicrosecond, uint32 } from "@uwdata/flechette";
import { test } from "vite-plus/test";
import { decodeColumns } from "../src/columns.ts";
import {
  applyCommand,
  checkDocument,
  checkPlan,
  checkRequest,
  checkResponse,
  CommandError,
  compileFormula,
  decodeBlock,
  editText,
  emptyDocument,
  emptySession,
  encodeBlock,
  exactNumberText,
  formulaText,
  fromTemporalTextForm,
  isValueOf,
  lowerText,
  migrateGridState,
  ProtocolError,
  readAttached,
  readCellText,
  repairDocument,
  sameCellValue,
  searchImplies,
  StateError,
  textOf,
  upperText,
  valueOfText,
} from "../src/index.ts";
import { blobSource, convertSheet, DateStyle, readWorkbook, serialDate, WorkbookError } from "../src/workbook.ts";
import { excelSerial, writeXlsx } from "../src/xlsx.ts";

test("valueOfText and exactNumberText round-trip §2.4 text forms", () => {
  assert.equal(exactNumberText(1e-7), "0.0000001");
  assert.equal(exactNumberText(125e-2), "1.25");
  assert.equal(exactNumberText(1e21), "1000000000000000000000");
  assert.equal(exactNumberText(1e38), null);
  assert.equal(fromTemporalTextForm("0045-03-15 (BC)"), "-000044-03-15");
  assert.equal(fromTemporalTextForm("10000-01-01 00:00:00+00"), "+010000-01-01 00:00:00+00");
  assert.equal(valueOfText("0045-03-15 (BC)", { type: "date" }), "-000044-03-15");
  assert.equal(valueOfText("10000-01-01 00:00:00", { type: "timestamp" }), "+010000-01-01 00:00:00");
  assert.equal(valueOfText("9007199254740993", { type: "bigint" }), "9007199254740993");
  assert.equal(valueOfText("42", { type: "bigint" }), 42);
  const bytesBase64 = valueOfText("\\x00AB\\x22\\x27\\x5C", { type: "binary" });
  assert.equal(textOf(bytesBase64, { type: "binary" }), "\\x00AB\\x22\\x27\\x5C");
});

test("lowerText, upperText and searchImplies follow §3.4 simple case mapping", () => {
  assert.equal(lowerText("İ"), "i");
  assert.equal(lowerText("ΣΑΣ"), "σασ");
  assert.equal(upperText("ß"), "ẞ");
  assert.equal(searchImplies({ search: "İ" }, { search: "i" }), true);
});

test("formula round-trips typed literals, -0 and bin widths", () => {
  const columns = [{ name: "x", type: "float" as const }];
  for (const source of ["INTEGER '2'", "BIGINT '2'", "DECIMAL '3'"]) {
    const compiled = compileFormula(source, columns);
    assert.equal(formulaText(compiled.expr), source);
  }
  assert.deepEqual(compileFormula("LEFT('abcd', INTEGER '2')", columns).expr, {
    fn: "left",
    args: [{ lit: "abcd" }, { lit: 2, type: "integer" }],
  });
  assert.deepEqual(compileFormula("INTEGER '-0'", columns).expr, { lit: 0, type: "integer" });
  assert.deepEqual(compileFormula("DATE '0045-03-15 (BC)'", columns).expr, { lit: "-000044-03-15", type: "date" });
  const binned = compileFormula("bin([x], 1e-7)", columns);
  assert.equal(formulaText(binned.expr), "BIN(x, 0.0000001)");
});

test("checkPlan unifies timestamp units commutatively and preserves typed null parameters", () => {
  const cols = [
    { name: "s", type: "timestamp" as const, unit: "s" as const },
    { name: "ns", type: "timestamp" as const, unit: "ns" as const },
    { name: "d", type: "decimal" as const, precision: 10, scale: 2 },
    { name: "f", type: "float" as const, bits: 32 as const },
  ];
  const checked = checkPlan(
    {
      derive: [
        { name: "a", expr: { fn: "coalesce", args: [{ col: "s" }, { col: "ns" }] } },
        { name: "b", expr: { fn: "coalesce", args: [{ col: "ns" }, { col: "s" }] } },
        { name: "c", expr: { fn: "coalesce", args: [{ lit: null, type: "decimal" }, { col: "d" }] } },
        { name: "g", expr: { fn: "coalesce", args: [{ lit: null, type: "float" }, { col: "f" }] } },
      ],
    },
    cols,
  );
  assert.deepEqual(checked.columns.slice(-4), [
    { name: "a", type: "timestamp", unit: "ns" },
    { name: "b", type: "timestamp", unit: "ns" },
    { name: "c", type: "decimal", precision: 10, scale: 2 },
    { name: "g", type: "float", bits: 32 },
  ]);
});

test("arrow readers floor-divide negative Date64/Time values and map unsigned widths", () => {
  const ipc = tableToIPC(
    tableFromArrays(
      {
        u: new Uint32Array([3_000_000_000]),
        i: new Int32Array([-7]),
        d: [-1],
        t: [100n],
      },
      { types: { u: uint32(), i: int32(), d: dateMillisecond(), t: timeMicrosecond() } },
    ),
    {},
  );
  assert.ok(ipc);
  const decodedCols = decodeColumns(ipc);
  assert.equal(decodedCols.columns[0].type, "bigint");
  assert.equal(decodedCols.columns[1].type, "integer");
  assert.equal(decodedCols.values[0].at(0), 3_000_000_000);
  assert.equal(decodedCols.values[2].at(0), "1969-12-31");
  const decoded = decodeBlock(encodeBlock([{ name: "d", type: "date" }], [["1969-12-31"]]));
  assert.deepEqual(decoded.rows, [["1969-12-31"]]);
});

test("input clears binary/interval on blank text and converts extended timestamptz in editText", () => {
  assert.deepEqual(readCellText("  ", { type: "binary" }), { ok: true, value: null });
  assert.deepEqual(readCellText("", { type: "interval" }), { ok: true, value: null });
  assert.equal(readCellText("abc", { type: "binary" }).ok, false);
  const shown = editText("+010000-01-01 00:00:00+00", { type: "timestamptz" }, { timeZone: "Asia/Tokyo" });
  assert.equal(shown, "10000-01-01 09:00:00+09");
  assert.deepEqual(readCellText(shown, { type: "timestamptz" }, { timeZone: "Asia/Tokyo" }), {
    ok: true,
    value: "+010000-01-01 00:00:00+00",
  });
});

test("migration reports both the original migration failures and the migrated sort removed for the current table", () => {
  const result = migrateGridState(
    {
      version: 1,
      schema: ["gone", "x"],
      query: {
        sort: [
          { column: 10, direction: "asc" },
          { column: 0, direction: "desc" },
          { column: 1, direction: "asc" },
        ],
      },
    },
    [{ name: "x", type: "integer" }],
  );
  assert.deepEqual(result.dropped, ["/query/sort/0"]);
  assert.ok(result.reasons[result.dropped[0]]);
  assert.deepEqual(result.removed, ["/plan/sort/0"]);
  assert.deepEqual(result.document.plan, { sort: [{ column: "x", direction: "asc" }] });
});

test("renaming a derived column to a measure's name carries its setting and keeps the measure setting if none was given", () => {
  const table = [{ name: "x", type: "integer" as const }];
  const plan = {
    derive: [{ name: "d", expr: { col: "x" } }],
    aggregate: { keys: [], measures: [{ name: "s", fn: "sum" as const, column: "d" }] },
  };
  const context = {
    table,
    revision: "r1",
    view: { columns: checkPlan(plan, table).columns, rowCount: 1, rowIds: false },
    page: 10,
  };
  const measure = { name: "s", width: 40 };
  for (const columns of [[{ name: "d", width: 90 }, measure], [measure]]) {
    const result = applyCommand(
      { document: { ...emptyDocument(), plan, columns }, session: emptySession() },
      { command: "derive.update", name: "d", rename: "s" },
      context,
    );
    assert.deepEqual(result.document.columns, [{ name: "s", width: columns[0].width }]);
  }
});

test("migrateGridState rejects empty versionless object and checkDocument validates format fields", () => {
  assert.throws(() => migrateGridState({}, [{ name: "a", type: "integer" }]), StateError);
  assert.throws(
    () =>
      checkDocument({
        kind: "vastgrid/document",
        version: 2,
        columns: [{ name: "a", format: { number: { fractionDigits: 101 } } }],
      }),
    StateError,
  );
  assert.throws(
    () => checkDocument({ kind: "vastgrid/document", version: 2, schema: [""] }),
    (error: unknown) => error instanceof StateError && error.path === "/schema/0",
  );
});

test("messages reject non-finite summarize numbers and malformed attached frames", () => {
  assert.throws(
    () =>
      checkResponse(
        { v: 2, id: 1, result: { count: 1, numericCount: 1, sum: Number.NaN, min: 0, max: 0, average: 0 } },
        "summarize",
      ),
    ProtocolError,
  );
  const bad = new Uint8Array(5);
  new DataView(bad.buffer).setUint32(0, 1, true);
  bad[4] = 0xff;
  assert.throws(() => readAttached(bad), ProtocolError);
});

test("commands validate syntax before unknown_column and bound huge cell selections without OOM", () => {
  const context = {
    table: [{ name: "a", type: "integer" as const }],
    revision: "r1",
    view: { columns: [{ name: "a", type: "integer" as const }], rowCount: 50_000_000, rowIds: true },
    page: 20,
  };
  const base = { document: emptyDocument(), session: emptySession() };
  assert.throws(
    () => applyCommand(base, { command: "column.resize", name: "missing", width: -5 }, context),
    (error: unknown) => error instanceof CommandError && error.reason === "syntax" && error.path === "/width",
  );
  assert.throws(
    () => applyCommand(base, { command: "column.show", names: ["a"], all: false }, context),
    (error: unknown) => error instanceof CommandError && error.reason === "syntax" && error.path === "/all",
  );
  const allSelected = applyCommand(base, { command: "select.all" }, context);
  assert.throws(
    () => applyCommand(allSelected, { command: "edit.clear" }, context),
    (error: unknown) => error instanceof CommandError && error.reason === "too_many_cells",
  );
  assert.throws(
    () => applyCommand(allSelected, { command: "copy" }, context),
    (error: unknown) => error instanceof CommandError && error.reason === "too_many_cells",
  );
});

test("xlsx writes binary and BC dates as §2.4 text and workbook reads '>' in sheet attributes", async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of writeXlsx(
    [
      { name: "b", type: "binary" },
      { name: "d", type: "date" },
    ],
    [[["AQID", "-000044-03-15"]]],
    { sheetName: "A > B" },
  )) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const base = blobSource(new Blob([raw]));
  const literalGtSource = {
    size: base.size,
    bytes: (start: number, end: number) => base.bytes(start, end),
    async *text(start: number, end: number, deflated: boolean, onRead?: (bytes: number) => void) {
      for await (const chunk of base.text(start, end, deflated, onRead)) {
        yield chunk.replace('name="A &gt; B"', 'name="A > B"');
      }
    },
  };
  const csvParts: string[] = [];
  const converted = await convertSheet(literalGtSource, (part) => {
    csvParts.push(part);
  });
  assert.equal(converted.sheet, "A > B");
  assert.deepEqual(
    converted.columns.map((column) => column.name),
    ["b", "d"],
  );
  assert.equal(csvParts.join(""), '2,"\\x01\\x02\\x03","0045-03-15 (BC)"\n');
});

test("decodeBlock and decodeColumns preserve leading U+FEFF in column names", () => {
  const bytes = encodeBlock([{ name: "\uFEFFid", type: "integer" }], [[42]]);
  assert.deepEqual(
    decodeBlock(bytes).columns.map((column) => column.name),
    ["\uFEFFid"],
  );
  assert.deepEqual(
    decodeColumns(bytes).columns.map((column) => column.name),
    ["\uFEFFid"],
  );
});

test("timestamp(s) and timestamp(ms) enforce microsecond ceiling, and decimal null unifies associatively", () => {
  assert.equal(isValueOf("+294247-01-10 04:00:54", { type: "timestamp", unit: "s" }), true);
  assert.equal(isValueOf("+294247-01-10 04:00:55", { type: "timestamp", unit: "s" }), false);
  assert.equal(isValueOf("+294247-01-10 04:00:54.775", { type: "timestamp", unit: "ms" }), true);
  assert.equal(isValueOf("+294247-01-10 04:00:54.776", { type: "timestamp", unit: "ms" }), false);
  const cols = [{ name: "i", type: "integer" as const }];
  const checked = checkPlan(
    {
      derive: [
        { name: "a", expr: { fn: "coalesce", args: [{ col: "i" }, { lit: null, type: "decimal" }] } },
        { name: "b", expr: { fn: "coalesce", args: [{ lit: null, type: "decimal" }, { col: "i" }] } },
      ],
    },
    cols,
  );
  assert.deepEqual(checked.columns[1], { name: "a", type: "decimal", precision: 11, scale: 0 });
  assert.deepEqual(checked.columns[2], { name: "b", type: "decimal", precision: 11, scale: 0 });
});

test("plan, state, message, input and xlsx edge cases stay consistent", async () => {
  const table = [
    { name: "k", type: "string" as const },
    { name: "p", type: "string" as const },
    { name: "x", type: "integer" as const },
  ];
  const docWithPivot = {
    ...emptyDocument(),
    plan: {
      derive: [{ name: "d", expr: { col: "x" } }],
      aggregate: { keys: ["k"], measures: [{ name: "s", fn: "sum" as const, column: "d" }], pivot: { columns: ["p"] } },
    },
  };
  const removed = applyCommand(
    { document: docWithPivot, session: emptySession() },
    { command: "derive.remove", name: "d" },
    { table, revision: "r1", view: { columns: table, rowCount: 1, rowIds: false }, page: 10 },
  );
  assert.equal(removed.document.plan?.aggregate?.pivot, undefined);

  const repaired = repairDocument(
    {
      ...emptyDocument(),
      plan: {
        derive: "bad" as never,
        where: 42 as never,
        aggregate: { keys: "bad" as never, measures: [] },
        sort: {} as never,
      },
    },
    table,
  );
  assert.deepEqual(repaired.removed, ["/plan/derive", "/plan/where", "/plan/aggregate", "/plan/sort"]);

  assert.equal(readCellText("550e8400-e29b41d4a716446655440000", { type: "uuid" }).ok, false);
  assert.equal(excelSerial("2023-02-29", "date"), null);
  assert.equal(excelSerial("2024-01-31 12:00:00", "date"), null);
  assert.equal(excelSerial("12:65:00", "time"), null);

  assert.throws(
    () =>
      checkRequest({
        v: 2,
        id: 1,
        op: "export",
        table: "t",
        revision: "r",
        plan: {},
        format: "xlsx",
        headers: ["a", "b"],
        numberFormats: ["0"],
      }),
    ProtocolError,
  );
  assert.throws(() => checkResponse({ v: 2, id: 1, result: null }, "bogus" as never), ProtocolError);

  const historyChunks: Uint8Array[] = [];
  for await (const chunk of writeXlsx([{ name: "x", type: "integer" }], [[[1]]], { sheetName: "History" })) {
    historyChunks.push(chunk);
  }
  const sheet = await convertSheet(blobSource(new Blob([Buffer.concat(historyChunks)])), () => {});
  assert.equal(sheet.sheet, "Sheet1");
});

test("workbook bounds inflated parts, malformed ZIP64 headers, PIs, serial rollover and large xlsx integers", async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of writeXlsx([{ name: "d", type: "decimal" }], [[["100000000000000000000000"]]])) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  assert.match(raw.toString("utf8"), /inlineStr.*100000000000000000000000/);

  const base = blobSource(new Blob([raw]));
  const bombSource = {
    size: base.size,
    bytes: (start: number, end: number) => base.bytes(start, end),
    async *text(start: number, end: number, deflated: boolean, onRead?: (bytes: number) => void) {
      for await (const chunk of base.text(start, end, deflated, onRead)) {
        if (chunk.includes("<workbook")) {
          const million = " ".repeat(1024 * 1024);
          for (let i = 0; i < 130; i++) yield million;
        }
        yield chunk;
      }
    },
  };
  await assert.rejects(() => readWorkbook(bombSource), WorkbookError);

  const piSource = {
    size: base.size,
    bytes: (start: number, end: number) => base.bytes(start, end),
    async *text(start: number, end: number, deflated: boolean, onRead?: (bytes: number) => void) {
      for await (const chunk of base.text(start, end, deflated, onRead)) {
        yield chunk.replace('<?xml version="1.0" encoding="UTF-8"?>', "<?pi unmatched 'quote > still inside?>");
      }
    },
  };
  assert.equal((await readWorkbook(piSource)).sheets[0]?.name, "Sheet1");

  assert.deepEqual(serialDate(0.999999999, DateStyle.Time, false), { kind: 32, text: "23:59:59.999" });
  assert.deepEqual(serialDate(2_958_465.999999999, DateStyle.Date, false), { kind: 8, text: "+010000-01-01" });
});

test("editing rowKey single-cell commit without context.rows, not_loaded precedence, and >53-bit range dedup", () => {
  const table = [
    { name: "id", type: "integer" as const },
    { name: "qty", type: "integer" as const },
  ];
  const doc = { ...emptyDocument(), rowKey: "id" };
  const evictedCommit = applyCommand(
    {
      document: doc,
      session: {
        ...emptySession(),
        active: { row: 0, column: "id", key: { value: 1 } },
        editor: { row: 0, column: "id", key: { value: 1 }, text: "99", value: 1 },
      },
    },
    { command: "edit.commit" },
    { table, revision: "r1", view: { columns: table, rowCount: 1, rowIds: true }, rows: [], page: 10 },
  );
  assert.deepEqual(evictedCommit.requests, [
    {
      op: "write",
      revision: "r1",
      rowKey: "id",
      updates: [{ key: { value: 1 }, column: "id", value: 99, previous: 1 }],
    },
  ]);
  const pushed = applyCommand(
    evictedCommit,
    { command: "history.push", updates: [{ key: { value: 1 }, column: "id", before: 1, after: 99 }] },
    { table, revision: "r1", view: { columns: table, rowCount: 1, rowIds: true }, rows: [], page: 10 },
  );
  const undone = applyCommand(
    pushed,
    { command: "history.undo" },
    { table, revision: "r1", view: { columns: table, rowCount: 1, rowIds: true }, rows: [], page: 10 },
  );
  assert.deepEqual(undone.requests, [
    {
      op: "write",
      revision: "r1",
      rowKey: "id",
      updates: [{ key: { value: 99 }, column: "id", value: 1, previous: 99 }],
    },
  ]);

  assert.throws(
    () =>
      applyCommand(
        { document: doc, session: emptySession() },
        { command: "edit.paste" },
        {
          table,
          revision: "r1",
          view: { columns: table, rowCount: 1, rowIds: true },
          rows: [{ start: 0, keys: [{ value: 1 }], columns: ["id", "qty"], values: [[1, 3]] }],
          clipboard: { text: "2\tbad" },
          page: 10,
        },
      ),
    (error: unknown) => error instanceof CommandError && error.reason === "not_loaded",
  );

  const hugeRow = 4_503_599_627_370_496; // 2^52; with 2 columns, row * 2 === 2^53 where Number loses +1!
  const multiRange = applyCommand(
    {
      document: emptyDocument(),
      session: {
        ...emptySession(),
        selection: [
          { rows: [hugeRow, hugeRow + 1], columns: ["id"] },
          { rows: [hugeRow, hugeRow + 1], columns: ["qty"] },
        ],
      },
    },
    { command: "edit.clear" },
    {
      table,
      revision: "r1",
      view: { columns: table, rowCount: hugeRow + 10, rowIds: true },
      rows: [{ start: hugeRow, keys: [{ rowId: hugeRow }], columns: ["id", "qty"], values: [[10, 20]] }],
      page: 10,
    },
  );
  assert.equal(multiRange.requests[0]?.op === "write" ? (multiRange.requests[0].updates as unknown[]).length : 0, 2);
});

test("BIN round-trips large widths, rejects lossy widths, equates -0.00 cells, and validates style expressions", () => {
  assert.equal(isValueOf("-0", { type: "bigint" }), true);
  assert.equal(isValueOf("-0.00", { type: "decimal", precision: 4, scale: 2 }), true);
  assert.equal(sameCellValue("-0.00", "0.00", { type: "decimal", precision: 4, scale: 2 }), true);
  assert.deepEqual(readCellText("45-03-15 BC", { type: "date" }), { ok: true, value: "-000044-03-15" });

  const cols = [
    { name: "f", type: "float" as const },
    { name: "d", type: "decimal" as const, precision: 38, scale: 2 },
    { name: "w", type: "decimal" as const, precision: 38, scale: 0 },
  ];
  const floatBin = compileFormula("BIN(f, 1e20)", cols);
  assert.deepEqual(compileFormula(formulaText(floatBin.expr), cols).expr, floatBin.expr);
  const wideBin = compileFormula("BIN(w, 1e21)", cols);
  assert.deepEqual(compileFormula(formulaText(wideBin.expr), cols).expr, wideBin.expr);
  assert.throws(() => compileFormula("BIN(d, 10000000000000000.25)", cols));

  const nullChecked = checkPlan(
    {
      derive: [
        {
          name: "a",
          expr: {
            fn: "coalesce",
            args: [
              { lit: null, type: "decimal" },
              { lit: null, type: "integer" },
            ],
          },
        },
        {
          name: "b",
          expr: {
            fn: "coalesce",
            args: [
              { lit: null, type: "integer" },
              { lit: null, type: "decimal" },
            ],
          },
        },
      ],
    },
    cols,
  );
  assert.deepEqual(nullChecked.columns.slice(-2), [
    { name: "a", type: "decimal", precision: 11, scale: 0 },
    { name: "b", type: "decimal", precision: 11, scale: 0 },
  ]);

  assert.throws(
    () =>
      checkDocument({
        kind: "vastgrid/document",
        version: 2,
        columns: [{ name: "f", format: { styles: [{ when: { bogus: 1 } as never, color: "red" }] } }],
      }),
    StateError,
  );

  const migrated = migrateGridState(
    {
      version: 1,
      schema: ["x"],
      formulas: [
        { name: "dup", expression: "[x] + 1" },
        { name: "dup", expression: "[x] + 2" },
        { name: "uses_dup", expression: "[dup] * 2" },
      ],
    },
    [{ name: "x", type: "integer" }],
  );
  assert.deepEqual(
    migrated.document.plan?.derive?.map((item) => item.name),
    ["dup", "uses_dup"],
  );
});
