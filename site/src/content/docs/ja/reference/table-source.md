---
title: TableSource と型
description: TableSource のインターフェース、ArraySource と RemoteSource、それらがグリッドとやり取りする型。
---

これらは `vastgrid-core` にあり、`vastgrid` からも再エクスポートしています。

座標について。`row` はビューでの位置で、0 から数えます。要求の `column` は、表のスキーマ（`TableInfo.columns`）での列の番号で、表示の位置ではありません。そのため、グリッドで列を隠したり動かしたりしても、ソースへの要求は変わりません。範囲は `[start, end)` です。

## `TableSource`

```ts
interface TableSource {
  /** 最初の呼び出しで表を開き、現在の状態を返す。`status` が `loading` の間は繰り返し呼ばれる。 */
  info(signal?: AbortSignal): Promise<TableInfo>;
  /**
   * 並べ替え・絞り込みしたビューを作る。空のクエリーでは表そのもの（`id: null`）を返す。
   * `options.preview` を付けると、作っている途中のビュー（`status: "building"`）を返すことがある。
   */
  createView(query: ViewQuery, signal?: AbortSignal, options?: { preview?: boolean }): Promise<ViewInfo>;
  /** ビューの現在の状態。`status` が `building` の間は繰り返し呼ばれる。 */
  viewInfo?(view: string, signal?: AbortSignal): Promise<ViewInfo>;
  readRows(request: RowRequest, signal?: AbortSignal): Promise<RowBlock>;
  columnStats?(view: string | null, column: number, signal?: AbortSignal): Promise<ColumnStats>;
  distinctValues?(request: DistinctRequest, signal?: AbortSignal): Promise<DistinctValues>;
  aggregate?(request: AggregateRequest, signal?: AbortSignal): Promise<SelectionSummary>;
  find?(request: FindRequest, signal?: AbortSignal): Promise<FindResult | null>;
  exportView?(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult>;
  /** capabilities.edit を報告する source で、セルをすべて書き込むか、何も書き込まない（下記）。 */
  updateCells?(request: UpdateRequest, signal?: AbortSignal): Promise<UpdateResult>;
  /** capabilities.save を報告する source で、書き込んだセルを表のファイルに保存する。 */
  saveEdits?(signal?: AbortSignal): Promise<{ records: number; edits: TableEdits }>;
  /** 表を解放する。以後、そのソースは使えない。 */
  /** 表全体が変わったときに `listener` を呼びます。返す関数を呼ぶまで続きます。 */
  subscribe?(listener: (change: { revision?: string | null }) => void): () => void;
  close?(): void | Promise<void>;
}
```

各メソッドにグリッドが何を求めるかは、[自作の TableSource](/ja/guides/custom-source/) で説明しています。

## `ArraySource`

```ts
new ArraySource({
  columns: (string | ColumnSchema)[]; // 列名（型は推測する）かスキーマ
  rows?: CellValue[][];               // 行ごとのデータ、または
  columnData?: CellValue[][];         // 列ごとのデータ。1 列に 1 つの配列
  editable?: boolean;                 // updateCells でセルを書き込む（既定は false）
});
```

すべての capability に対応します。`exportView` は `csv`・`tsv`・`json`・`xlsx`（`parquet` は除く）を書き、ファイルを `Blob` として `ExportResult.data` に返します（`exports.delivery` は `"data"`）。[メモリ上のデータ](/ja/guides/in-memory/)と[書き出し](/ja/guides/export/)を参照してください。

## `RemoteSource`

```ts
new RemoteSource({
  endpoint: string;                    // プロトコルの要求（POST、JSON）を受ける URL
  ref: string;                         // 開くもの。サーバーが解釈する形で書く
  read?: ReadOptions;                  // ブック: sheet、headerRow、keepEmptyRows、keepEmptyColumns
  headers?: Record<string, string>;    // すべての要求に付けるヘッダー
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  changes?: ChangeTransport | false;   // 表の変更を知る方法。既定は pollChanges()
});
```

[表のプロトコル](/ja/reference/protocol/)を話します。サーバーが表やビューを忘れた場合（再起動した、ファイルが変わったなど）は、`RemoteSource` が表を開き直し、同じクエリーでビューを作り直します。

グリッドが購読している間、`RemoteSource` は `changes` の転送方式で表を監視します。既定の `pollChanges({ interval: 2000 })` は `interval` ミリ秒ごとに `revision` 要求を送り、最後に `info` で読んだものと違う revision を 1 回だけ通知します。要求が失敗したあとは、次の応答で追いつきます。サーバーがこの要求を知らない場合は監視をやめます。自作の転送方式は `{ ref, check(signal?), changed(revision?) }` を受け取ります。サーバーから変更が届いたら（Server-Sent Events など）`changed` を、問い合わせるときは `check` を呼びます。`changes: false` で監視しません。

```ts
const pushed: ChangeTransport = {
  watch({ ref, changed }) {
    const events = new EventSource(`/api/changes?ref=${encodeURIComponent(ref)}`);
    events.onmessage = (event) => changed(event.data);
    return () => events.close();
  },
};
```

## 値と列

```ts
type CellValue = string | number | boolean | null;

type ColumnType =
  | "integer" | "bigint" | "float" | "decimal" | "boolean" | "string"
  | "date" | "time" | "timestamp" | "timestamptz" | "interval" | "uuid"
  | "binary" | "list" | "struct" | "map" | "json" | "unknown";

interface ColumnSchema {
  name: string;
  type: ColumnType;
  /** エンジンでの型の名前。たとえば `DECIMAL(10,2)`。 */
  sourceType?: string;
}
```

正確に表せない数（64 ビットの整数、小数、`NaN`、`Infinity`）は文字列です。入れ子の値とバイナリの値は、それを文字列で表したものです。

## `TableInfo`

```ts
interface TableInfo {
  columns: ColumnSchema[];
  rowCount: number | null;      // エンジンが数えている間は null
  readableRows: number;         // 今読める行の数。読み込み中は先頭のプレビュー
  status: "loading" | "ready" | "error";
  progress?: number | null;     // 読み込み中、分かる場合は 0..1
  error?: string;
  format?: string;              // csv, tsv, parquet, ndjson, xlsx, …
  byteSize?: number;
  revision?: string;            // 元のデータが変わると変わる
  notes?: string[];             // encoding:<name>, all_varchar, invalid_utf8_replaced, merged_cells, formulas_without_values
  sheets?: { name: string; hidden?: boolean }[]; // ブック: 読めるシート
  sheet?: string;               // ブック: 読んだシート
  capabilities: {
    sort: boolean;
    filter: boolean;
    search: boolean;
    stats: boolean;
    distinct: boolean;
    aggregate: boolean;
    find: boolean;
    export: boolean;
    conditions?: boolean; // `ViewQuery.where` を評価できる。省略は false
    formulas?: boolean;   // `ViewQuery.formulas` を評価できる。省略は false
  };
  exports?: { formats: ExportFormat[]; delivery: "file" | "data" }; // 書き出せるとき、exportView が書く形式
}
```

`exports.delivery` は、ファイルが利用者に届く方法をグリッドに伝えます。`"file"` の source（サーバー）は要求の `target` に新しいファイルを書き、`"data"` の source はその中身（`ExportResult.data`）を返します。`capabilities.export` があって `exports` がない source は、`csv`・`tsv`・`parquet`・`json` のファイルを書きます。

## `ViewQuery`

```ts
interface ViewQuery {
  formulas?: { name: string; expression: string }[];      // 計算列。表の列の後ろに並ぶ
  sort?: { column: number; direction: "asc" | "desc" }[]; // 空白は昇順でも降順でも最後
  filters?: Filter[];                                     // すべてに合う行を残す
  where?: FilterNode;                                     // 条件木。filters と AND で組み合わせる
  search?: string;                                        // どれかの表の列が含む行を残す。大文字と小文字は区別しない
}

type Filter =
  /** 値が `values` のどれかである行（`exclude` では、どれでもない行）。`null` は空白に合う。 */
  | { type: "values"; column: number; values: CellValue[]; exclude?: boolean }
  | { type: "compare"; column: number; op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; value: string | number | boolean }
  /** 両端を含む。どちらの端も省ける。 */
  | { type: "between"; column: number; min?: string | number | boolean; max?: string | number | boolean }
  | {
      type: "text";
      column: number;
      op: "contains" | "notContains" | "startsWith" | "endsWith" | "equals" | "notEquals";
      value: string;
      caseSensitive?: boolean;
    }
  /** 空白は `null` か空の文字列。 */
  | { type: "blank"; column: number; blank: boolean };

/** `and` はすべての条件に、`or` はどれかの条件に合う行を残す。条件のないグループは、ないものとして扱う。 */
type FilterNode = Filter | { type: "and" | "or"; filters: FilterNode[] };

interface ViewInfo {
  id: string | null;      // null は元の順番の表
  rowCount: number;       // 作っている途中でも、ビュー全体の行数
  query: ViewQuery;
  status?: "building" | "ready" | "error"; // ないときは ready
  readableRows?: number;  // 先頭から、いま読める行数。ないときは rowCount
  error?: string;         // 作れなかった理由
}
```

グリッドはビューを `{ preview: true }` 付きで求めます。ソースは、すべての行を並べ終える前に並べ替えに答えてもかまいません。そのときは `status: "building"` と、先頭の `readableRows` 行を返します。この行は、完成したビューの先頭の行と同じでなければなりません（同じ値の行は、表での位置の順にします）。グリッドはそれをすぐに表示し、`viewInfo` を繰り返し呼び（ないときは、オプションなしの `createView` をもう一度呼んで待ちます）、ビューが `ready` になると残りの行を読めるようにします。それまでは、`readableRows` より先の行は読み込み中と表示します。選択とスクロールはすべての行でできますが、その先の行を含むコピーと選択範囲の集計、検索、絞り込んだビューの統計は、完成を待ちます。オプションを無視するソースは、ビューが完成してから答えれば十分です。

`where` は、`filters` では表せない、列をまたぐ OR、入れ子のグループ、同じ列の複数の条件を表します。「(地域が東京 または 売上が10万超) かつ 状態が取消以外」は次のとおりです。

```ts
const query: ViewQuery = {
  filters: [{ type: "values", column: 2, values: ["取消"], exclude: true }],
  where: {
    type: "or",
    filters: [
      { type: "values", column: 0, values: ["東京"] },
      { type: "compare", column: 1, op: "gt", value: 100_000 },
    ],
  },
};
```

それぞれの条件の意味は `filters` と同じです。`where` を評価できる source は `capabilities.conditions` を報告します。グリッドはそうした source にだけ条件木を送るので、条件木より前に書かれた source もそのまま動きます。source は、1 つの条件を自分で判定する関数 `test` を渡して `matchesFilterNode(where, test)` で木を評価できます（`ArraySource` もこの方法です）。木の大きさの上限は[プロトコル](/ja/reference/protocol/#viewquery)にあります。

`formulas` は、行ごとに式で計算する列を加えます。式 `i` は、そのビューを指定するすべての要求で列 `columns.length + i` です。ビューを指定しない要求には計算列がないので、式だけのクエリーでも（表の順の）ビューを作ります。式を評価できる source は `capabilities.formulas` を報告し、`queryFormulas(info.columns, query)` で式を確かめ（ない列・型の誤り・循環参照は `invalid_request` を投げます）、確かめた木を `formulaEvaluator` などで評価します。[計算列](/ja/guides/formulas/#独自の-source)を参照してください。
## 行

```ts
interface RowRequest {
  view: string | null;
  start: number;      // 最初の行（含む）
  end: number;        // 最後の行（含まない）
  columns: number[];  // スキーマでの列の番号
  textLimit?: number; // セルごとの文字列の最大の長さ。超える文字列は末尾が "…" になる
}

interface RowBlock {
  start: number;
  end: number;
  columns: CellValue[][];    // 要求した列ごとに 1 つの配列。要求の順
  rowIds?: number[] | null;  // ビューの場合、元の表での位置
}
```

`MAX_TEXT_LIMIT`（1,000,000）は値の全体を読むための `textLimit` で、コピーと「値の全体を表示」で使います。

## 統計、値の一覧、選択範囲

`vastgrid-duckdb` では、平均・標準偏差・四分位・分布を `NaN` と無限大を除いて計算します。有限の値がないときは、
平均・標準偏差・四分位は `null` となり、分布は省略されます。行数・null の数・値の種類の数は列全体で数えます。

```ts
interface ColumnStats {
  column: number;
  rows: number;
  nulls: number;
  distinct: number | null;
  distinctApproximate?: boolean;
  min?: CellValue;
  max?: CellValue;
  mean?: number | null;
  stddev?: number | null;
  quantiles?: CellValue[] | null;                       // 25・50・75 パーセンタイル
  minLength?: number | null;
  maxLength?: number | null;
  histogram?: { start: number; end: number; count: number }[] | null;
  top?: { value: CellValue; count: number }[] | null;   // 多い値
}

interface DistinctRequest { view: string | null; column: number; search?: string; limit?: number }
interface DistinctValues { values: { value: CellValue; count: number }[]; truncated: boolean }

interface AggregateRequest { view: string | null; ranges: { start: number; end: number; columns: number[] }[] }
interface SelectionSummary {
  count: number;         // 空白でないセルの数
  numericCount: number;  // 数値のセルの数
  sum: number | null;
  min: number | null;
  max: number | null;
  average: number | null;
}
```

## 検索と書き出し

```ts
interface FindRequest {
  view: string | null;
  text: string;
  columns: number[];   // スキーマでの列の番号を表示の順に並べたもの。行を順にたどり、各行でこれらの列を順に見る
  row: number;         // 開始位置。行と、`columns` の中の位置。開始のセルそのものは飛ばす
  column: number;
  direction: 1 | -1;
  caseSensitive?: boolean;
}
interface FindResult { row: number; column: number } // `column` は `FindRequest.columns` の中の位置

type ExportFormat = "csv" | "tsv" | "parquet" | "json" | "xlsx";

interface ExportRequest {
  view: string | null;          // ビューの絞り込み・検索・並べ替えが効く。null は表そのもの
  format: ExportFormat;
  columns?: number[];           // スキーマでの列の番号を、書く順に
  headers?: string[];           // csv・tsv・xlsx の列ごとの見出し（parquet と json は列名のまま）
  numberFormats?: (string | null)[]; // xlsx: 列ごとの Excel の表示形式。null は型の既定
  target: string;               // ホストが解釈する。"data" の source ではファイル名
}
interface ExportResult { target: string; rows: number; data?: Blob }
```

`xlsx` が数値・日付・文字（数式にはしない）・`null` をどう書くか、Excel のシートに収まらない行・列を `export_too_large` で断ることは、[プロトコル](/ja/reference/protocol/#excel-export-rules)と[書き出し](/ja/guides/export/#excel-ファイル)にあります。

## セルの書き込み

```ts
interface UpdateRequest {
  updates: { row: number; column: number; value: CellValue; previous?: CellValue }[]; // MAX_UPDATE_CELLS（100,000）まで
  revision?: string; // 行を読んだときの TableInfo.revision
}
interface UpdateResult {
  updated: number;
  edits: { version: number; cells: number }; // 書き込み後の TableInfo.edits
}
```

`capabilities.edit` を報告する source は、`updateCells` でセルを書き込みます。`row` は表の中の行の位置（`RowBlock.rowIds`）、`column` はスキーマの列番号です。要求は不可分で、すべてを書き込むか、何も書き込まずに `SourceError` で reject します。コードは `read_only`（source か列が書き込めない）、`invalid_value`（値が列に合わない）、`edit_conflict`（セルが `previous` の値ではなくなっている）、`revision_changed`（表の `revision` が違う）、`invalid_request` です。

書き込みは行の位置と `revision` を変えず、代わりに `TableInfo.edits.version` を増やします。変更を通知する source は、`subscribe` のリスナーを `{ edits }` で呼びます。以降の要求はすべて新しい値を読みますが、それ以前に作ったビューは古い行と順序のままのことがあるため、グリッドはクエリが書き込んだ列を使うときにビューを作り直します。source が書き込まない列は、スキーマで `readOnly: true` になります。

`capabilities.save` を報告する source は、`saveEdits` で書き込んだセルを読み込んだファイルにも保存します（`saveFiles` を指定した DuckDB サーバー）。読み込んだ後にファイルが他の人に変更されていれば `file_changed`、書き戻せないファイルなら `save_unsupported` で reject します。保存後も表の revision と行の位置は変わらず、セルは保存済み（`edits.cells` が 0）になります。

`parseCellInput(text, column)` は入力した文字列を列の型として読み、`normalizeCellValue(value, column)` はプログラムが書き込む値を同じ規則で確かめます。どちらも 64 ビット整数と decimal を文字列のまま保ちます。`editableType(type)`・`editableColumn(schema)`・`editText(value)`・`sameCellValue(a, b)` も source とエディターで使えます。[セルの編集](/ja/guides/editing/)を参照してください。

## エラー

```ts
class SourceError extends Error {
  constructor(code: string, message: string, status?: number);
  readonly code: string;   // プログラム向けの、変わらないコード
  readonly status: number; // サーバーから送られたときの HTTP のステータス
}
```

`ErrorCodes` には、`ErrorCodes.viewNotFound`（`"view_not_found"`）のように、プロトコルのすべてのコードの定数があります。コードの一覧は[プロトコル](/ja/reference/protocol/#error-codes)にあります。`abortError()` は、シグナルが中止されたときに reject するためのエラーを作り、`isAbortError(error)` はそのエラーかどうかを判定します。

## 補助の関数

| エクスポート | 説明 |
| --- | --- |
| `isEmptyQuery(query)` | クエリーに並べ替え・絞り込み・条件木・検索がないかどうか。 |
| `filtersRows(query)` | クエリーが、並べ替えだけでなく行を除く（絞り込み・条件木・検索がある）かどうか。 |
| `matchesFilterNode(node, test)` | 1 つの条件を判定する関数を使って、条件木に合うかどうかを返します。 |
| `pruneFilterNode(node)`、`mapFilterNode(node, map)` | 空のグループを除いた木。条件を置き換えたり除いたりした木。 |
| `filterLeaves(node)`、`queryFilters(query)`、`queryCondition(query)` | 木やクエリーの条件の一覧。クエリーの `filters` と `where` を 1 つにした木。 |
| `isFilterGroup(node)` | ノードが `and` か `or` のグループかどうか。 |
| `plainText(value)` | クリップボード用の値の文字列。桁の区切りも切り詰めもしない。 |
| `numericValue(value, type)` | 値を JavaScript の数値にしたもの。数値でなければ `null`。 |
| `ValueFormatter` | グリッドと同じように、ロケールに合わせて値を表示用に整えます。 |
| `toTsv`、`toHtmlTable`、`toMarkdownTable` | グリッドのコピーと同じ形式で、値の行を文字列にします。 |
| `parseTsv(text)`、`parseHtmlTable(html)` | クリップボードからセルの行を読みます。表計算ソフトがコピーするタブ区切り（タブや改行を含む引用符付きのフィールド）と、HTML の最初の表（`colspan`・`rowspan` は空のセルで埋める）を、DOM を使わずに読みます。 |
| `copyLayout(ranges)` | 複数の範囲をコピーするときの行と列。まとめてコピーできない範囲では null を返します。 |
| `isNumericType(type)`、`isTemporalType(type)` | 列の型を分類します。 |
| `parseProtocolRequest(body)` | サーバー向けに、プロトコルの要求を検証します。 |
| `writeTableFile(format, columns, rows, options?)` | 行のまとまりから `csv`・`tsv`・`json`・`xlsx` をバイトのストリームとして書きます。自分で書き出す source 向けです。 |
| `writeXlsx(columns, rows, options?)` | 依存なしで Excel のブックをストリームとして書きます。`options.deflate` で圧縮します（`browserDeflate()` は `CompressionStream` を使います）。 |
| `excelNumberFormat(schema, format, options?)` | 列の `ColumnFormat` に当たる Excel の表示形式、または `null`。 |
| `checkXlsxSize(rows, columns)`、`XLSX_MAX_ROWS`、`XLSX_MAX_COLUMNS`、`XLSX_MAX_TEXT` | Excel の上限。 |
| `EXPORT_EXTENSIONS`、`EXPORT_MEDIA_TYPES` | 書き出し形式ごとの拡張子とメディアタイプ。 |
| `RowCache`、`ScrollAxis`、`SelectionModel`、`ColumnLayout` | フレームワークに依存しない、グリッドの部品。別のグリッドを作るときに使えます。 |
