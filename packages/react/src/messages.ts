import type { CellInputError } from "vastgrid-core";

/** Every text the grid shows. Pass a partial object to `messages` to change some of them. */
export interface Messages {
  gridLabel: string;
  loading: string;
  loadingRows: (loaded: string) => string;
  loadingProgress: (percent: string) => string;
  buildingView: string;
  /** A sorted view shows its first rows while the rest is sorted. */
  sortingRows: (readable: string, total: string) => string;
  /** Copying or finding past the rows of a view that is still sorting. */
  waitForSort: string;
  noRows: string;
  error: string;
  retry: string;
  rows: (count: string) => string;
  rowsOf: (shown: string, total: string) => string;
  search: string;
  searchPlaceholder: string;
  clearSearch: string;
  clearFilters: string;
  removeFilter: (label: string) => string;
  columns: string;
  showAllColumns: string;
  sortAscending: string;
  sortDescending: string;
  addSortAscending: string;
  addSortDescending: string;
  clearSort: string;
  filter: string;
  filterBy: (column: string) => string;
  statistics: string;
  hideColumn: string;
  freezeUpTo: string;
  unfreeze: string;
  autoFit: string;
  copy: string;
  copyWithHeaders: string;
  copyAsMarkdown: string;
  copyColumnName: string;
  copied: (cells: string) => string;
  copyTooLarge: (limit: string) => string;
  copyFailed: string;
  /** Several ranges that have neither the same rows nor the same columns. */
  copyRanges: string;
  copyCanceled: string;
  copying: string;
  filterToValue: string;
  excludeValue: string;
  inspectCell: string;
  /** Before the text a cell shows, when its value is formatted. */
  shownAs: string;
  close: string;
  apply: string;
  clear: string;
  cancel: string;
  selectAll: string;
  blank: string;
  valuesTruncated: (shown: string) => string;
  valuesSearch: string;
  condition: string;
  conditionNone: string;
  /** The toolbar button that opens the conditions builder, and the builder's title. */
  conditions: string;
  conditionsTitle: string;
  /** A group whose conditions must all match, or of which one must match. */
  matchAll: string;
  matchAny: string;
  /** Joins conditions in labels ("A and B"). */
  and: string;
  or: string;
  addCondition: string;
  addGroup: string;
  removeCondition: string;
  removeGroup: string;
  noConditions: string;
  conditionColumn: string;
  /** Operators of value lists, which the column's filter panel sets. */
  oneOf: string;
  noneOf: string;
  /** In a column's filter panel: open the builder with this column's filter and a new condition. */
  addAnd: string;
  addOr: string;
  inConditions: string;
  editConditions: string;
  operators: Record<
    | "eq"
    | "ne"
    | "lt"
    | "le"
    | "gt"
    | "ge"
    | "between"
    | "contains"
    | "notContains"
    | "startsWith"
    | "endsWith"
    | "equals"
    | "notEquals"
    | "blank"
    | "notBlank",
    string
  >;
  value: string;
  minimum: string;
  maximum: string;
  matchCase: string;
  find: string;
  findPlaceholder: string;
  findNext: string;
  findPrevious: string;
  notFound: string;
  searching: string;
  stats: {
    rows: string;
    nulls: string;
    distinct: string;
    approximate: string;
    min: string;
    max: string;
    mean: string;
    stddev: string;
    quartiles: string;
    length: string;
    histogram: string;
    top: string;
  };
  summary: {
    count: string;
    numericCount: string;
    sum: string;
    average: string;
    min: string;
    max: string;
  };
  types: Record<string, string>;
  sortedBy: (columns: string) => string;
  filtered: string;
  cell: (row: string, column: string) => string;
  originalRow: (row: string) => string;
  /** The checkbox of every row (in the corner). */
  checkAllRows: string;
  /** The checkbox of a row, by its number in the view. */
  checkRow: (row: string) => string;
  rowChecked: (row: string) => string;
  rowUnchecked: (row: string) => string;
  /** Checked rows; `null` when every row matching a filter is checked and they were not counted. */
  rowsChecked: (count: string | null) => string;
  rowsUnchecked: string;
  uncheckAllRows: string;
  textTruncated: string;
  /** The detail panel, which shows every column of the active row. */
  detailLabel: string;
  detailTitle: (row: string) => string;
  /** Context menu item that opens or closes the detail panel. */
  showDetail: string;
  detailFailed: string;
  /** After the label of a column that is hidden in the grid. */
  detailHidden: string;
  detailEmpty: string;
  notes: Record<string, string>;
  export: string;
  exportFormat: string;
  exportFormats: Record<"csv" | "tsv" | "parquet" | "json" | "xlsx", string>;
  exportRows: string;
  /** The rows of the current view, with its filters, search and sort. */
  exportViewRows: (count: string) => string;
  /** Every row of the table, in its original order. */
  exportTableRows: (count: string) => string;
  exportColumns: string;
  exportVisibleColumns: (count: string) => string;
  exportAllColumns: (count: string) => string;
  /** Write the column labels (and, for Excel, number and date formats) of `columnFormats`. */
  exportDisplaySettings: string;
  exportFileName: string;
  /** The button of a source that writes the file itself (for example on a server). */
  exportSave: string;
  /** The button of a source whose file the browser downloads. */
  exportDownload: string;
  exportSaveHint: string;
  exportDownloadHint: string;
  exporting: string;
  exportCancelled: string;
  /** The table changed (for example its file was rewritten) while it was exported. */
  exportInterrupted: string;
  exportFailed: (message: string) => string;
  exported: (rows: string, target: string) => string;
  exportXlsxRows: (rows: string) => string;
  exportXlsxColumns: (columns: string) => string;
  /** Context menu items, and the label of the cell editor. */
  editCell: string;
  clearCells: string;
  editorLabel: (cell: string) => string;
  /** Under the editor: how to save, cancel and start a new line. */
  editHint: string;
  /** While `validateCell` checks a value. */
  editChecking: string;
  /** Why a value does not fit its column, by `CellInputError`. */
  editInvalid: Record<CellInputError, string>;
  editReadOnly: string;
  /** Some cells cannot take their values: how many, and the first problem. */
  editProblems: (cells: string, first: string) => string;
  editTooLarge: (limit: string) => string;
  editSaving: (cells: string) => string;
  editSaved: (cells: string) => string;
  editFailed: (message: string) => string;
  /** Another change of the same cells was saved first. */
  editConflict: string;
  /** The table was read again (another revision): the write cannot be sent again. */
  editRevisionChanged: string;
  editOverwrite: string;
  editDiscard: string;
}

export const en: Messages = {
  gridLabel: "Data table",
  loading: "Loading…",
  loadingRows: (loaded) => `Loading… ${loaded} rows ready`,
  loadingProgress: (percent) => `Loading ${percent}`,
  buildingView: "Sorting and filtering…",
  sortingRows: (readable, total) => `Sorting… showing the first ${readable} of ${total} rows`,
  waitForSort: "Available once sorting is done.",
  noRows: "No rows",
  error: "The table could not be shown.",
  retry: "Retry",
  rows: (count) => `${count} rows`,
  rowsOf: (shown, total) => `${shown} of ${total} rows`,
  search: "Search",
  searchPlaceholder: "Search all columns",
  clearSearch: "Clear search",
  clearFilters: "Clear all",
  removeFilter: (label) => `Remove filter: ${label}`,
  columns: "Columns",
  showAllColumns: "Show all",
  sortAscending: "Sort ascending",
  sortDescending: "Sort descending",
  addSortAscending: "Then sort ascending",
  addSortDescending: "Then sort descending",
  clearSort: "Clear sort",
  filter: "Filter…",
  filterBy: (column) => `Filter ${column}`,
  statistics: "Column statistics",
  hideColumn: "Hide column",
  freezeUpTo: "Freeze up to this column",
  unfreeze: "Unfreeze columns",
  autoFit: "Fit width to content",
  copy: "Copy",
  copyWithHeaders: "Copy with headers",
  copyAsMarkdown: "Copy as Markdown",
  copyColumnName: "Copy column name",
  copied: (cells) => `Copied ${cells} cells`,
  copyTooLarge: (limit) => `Select at most ${limit} cells to copy.`,
  copyFailed: "Could not write to the clipboard.",
  copyRanges: "Ranges can be copied together when they have the same rows or the same columns.",
  copyCanceled: "Copy canceled.",
  copying: "Copying… Press Esc to cancel.",
  filterToValue: "Filter to this value",
  excludeValue: "Exclude this value",
  inspectCell: "Show full value",
  shownAs: "Shown as",
  close: "Close",
  apply: "Apply",
  clear: "Clear",
  cancel: "Cancel",
  selectAll: "(Select all)",
  blank: "(Blank)",
  valuesTruncated: (shown) => `Showing the ${shown} most common values. Search to find others.`,
  valuesSearch: "Search values",
  condition: "Condition",
  conditionNone: "None",
  conditions: "Conditions…",
  conditionsTitle: "Filter conditions",
  matchAll: "All of these (AND)",
  matchAny: "Any of these (OR)",
  and: "and",
  or: "or",
  addCondition: "Add condition",
  addGroup: "Add group",
  removeCondition: "Remove condition",
  removeGroup: "Remove group",
  noConditions: "No conditions. Add one to filter the rows.",
  conditionColumn: "Column",
  oneOf: "One of the values",
  noneOf: "None of the values",
  addAnd: "Add condition (AND)…",
  addOr: "Add condition (OR)…",
  inConditions: "This column is also used in the filter conditions.",
  editConditions: "Edit conditions…",
  operators: {
    eq: "Equals",
    ne: "Does not equal",
    lt: "Less than",
    le: "Less than or equal to",
    gt: "Greater than",
    ge: "Greater than or equal to",
    between: "Between",
    contains: "Contains",
    notContains: "Does not contain",
    startsWith: "Begins with",
    endsWith: "Ends with",
    equals: "Equals",
    notEquals: "Does not equal",
    blank: "Is blank",
    notBlank: "Is not blank",
  },
  value: "Value",
  minimum: "From",
  maximum: "To",
  matchCase: "Match case",
  find: "Find",
  findPlaceholder: "Find in table",
  findNext: "Next match",
  findPrevious: "Previous match",
  notFound: "No matches",
  searching: "Searching…",
  stats: {
    rows: "Rows",
    nulls: "Blank",
    distinct: "Distinct",
    approximate: "approx.",
    min: "Min",
    max: "Max",
    mean: "Mean",
    stddev: "Std. dev.",
    quartiles: "Quartiles",
    length: "Length",
    histogram: "Distribution",
    top: "Most common",
  },
  summary: {
    count: "Count",
    numericCount: "Numbers",
    sum: "Sum",
    average: "Average",
    min: "Min",
    max: "Max",
  },
  types: {
    integer: "Integer",
    bigint: "Integer",
    float: "Number",
    decimal: "Decimal",
    boolean: "Boolean",
    string: "Text",
    date: "Date",
    time: "Time",
    timestamp: "Date and time",
    timestamptz: "Date and time (zone)",
    interval: "Interval",
    uuid: "UUID",
    binary: "Binary",
    list: "List",
    struct: "Struct",
    map: "Map",
    json: "JSON",
    unknown: "Other",
  },
  sortedBy: (columns) => `Sorted by ${columns}`,
  filtered: "Filtered",
  cell: (row, column) => `Row ${row}, ${column}`,
  originalRow: (row) => `Row ${row} in the file`,
  checkAllRows: "Check every row",
  checkRow: (row) => `Check row ${row}`,
  rowChecked: (row) => `Row ${row} checked`,
  rowUnchecked: (row) => `Row ${row} unchecked`,
  rowsChecked: (count) => (count === null ? "Matching rows checked" : `${count} rows checked`),
  rowsUnchecked: "No rows checked",
  uncheckAllRows: "Uncheck every row",
  textTruncated: "Long text is cut in the table. Show the full value to read all of it.",
  detailLabel: "Row details",
  detailTitle: (row) => `Row ${row}`,
  showDetail: "Show row details",
  detailFailed: "Could not read the row.",
  detailHidden: "hidden",
  detailEmpty: "No row to show.",
  notes: {
    all_varchar: "Some rows did not match the column types, so every column was read as text.",
    invalid_utf8_replaced: "Invalid characters were replaced with �.",
    "encoding:shift_jis": "Converted from Shift_JIS.",
    "encoding:euc-jp": "Converted from EUC-JP.",
    "encoding:latin-1": "Converted from Latin-1.",
    "encoding:utf-16": "Converted from UTF-16.",
    merged_cells: "Merged cells show their value in the first cell only.",
    formulas_without_values: "Some formulas were saved without a calculated value and are shown blank.",
  },
  export: "Export",
  exportFormat: "Format",
  exportFormats: { csv: "CSV", tsv: "TSV", parquet: "Parquet", json: "JSON", xlsx: "Excel (.xlsx)" },
  exportRows: "Rows",
  exportViewRows: (count) => `Current view: ${count} rows, filtered and sorted as shown`,
  exportTableRows: (count) => `Whole table: ${count} rows, in file order`,
  exportColumns: "Columns",
  exportVisibleColumns: (count) => `Shown columns, in display order (${count})`,
  exportAllColumns: (count) => `All columns (${count})`,
  exportDisplaySettings: "Use the column labels, and number and date formats in Excel",
  exportFileName: "File name",
  exportSave: "Save",
  exportDownload: "Download",
  exportSaveHint: "The server writes the file.",
  exportDownloadHint: "The browser downloads the file.",
  exporting: "Exporting…",
  exportCancelled: "Export cancelled.",
  exportInterrupted: "The table changed while it was exported. Export it again.",
  exportFailed: (message) => `Export failed: ${message}`,
  exported: (rows, target) => `Exported ${rows} rows to ${target}.`,
  exportXlsxRows: (rows) => `An Excel sheet holds at most ${rows} rows. Filter the rows or choose another format.`,
  exportXlsxColumns: (columns) =>
    `An Excel sheet holds at most ${columns} columns. Hide columns or choose another format.`,
  editCell: "Edit cell",
  clearCells: "Clear contents",
  editorLabel: (cell) => `Edit ${cell}`,
  editHint: "Enter to save · Esc to cancel · Alt+Enter for a new line",
  editChecking: "Checking…",
  editInvalid: {
    integer: "Enter a whole number.",
    range: "The number is outside the range of this column.",
    number: "Enter a number.",
    decimal: "Enter a decimal number without an exponent.",
    scale: "Too many digits after the decimal point for this column.",
    precision: "Too many digits for this column.",
    boolean: "Enter true or false.",
    date: "Enter a date as yyyy-mm-dd.",
    time: "Enter a time as hh:mm or hh:mm:ss.",
    timestamp: "Enter a date and time as yyyy-mm-dd hh:mm:ss.",
    uuid: "Enter a UUID.",
    json: "Enter valid JSON.",
    type: "Values of this type cannot be edited.",
  },
  editReadOnly: "This column is read-only.",
  editProblems: (cells, first) => `${cells} cells cannot take their values. ${first}`,
  editTooLarge: (limit) => `Change at most ${limit} cells at once.`,
  editSaving: (cells) => `Saving ${cells} cells…`,
  editSaved: (cells) => `Saved ${cells} cells.`,
  editFailed: (message) => `Not saved: ${message}`,
  editConflict: "Not saved: the cells were changed meanwhile. Their current values are shown.",
  editRevisionChanged: "Not saved: the table was read again, so its rows may be other records now.",
  editOverwrite: "Overwrite",
  editDiscard: "Discard",
};

const number = (value: string) => value;

export const ja: Messages = {
  gridLabel: "データの表",
  loading: "読み込んでいます…",
  loadingRows: (loaded) => `読み込んでいます… ${loaded} 行を表示できます`,
  loadingProgress: (percent) => `読み込み中 ${percent}`,
  buildingView: "並べ替え・絞り込みをしています…",
  sortingRows: (readable, total) => `並べ替えています… ${total} 行のうち先頭の ${readable} 行を表示中`,
  waitForSort: "並べ替えが終わると使えます。",
  noRows: "行がありません",
  error: "表を表示できませんでした。",
  retry: "再試行",
  rows: (count) => `${number(count)} 行`,
  rowsOf: (shown, total) => `${shown} / ${total} 行`,
  search: "検索",
  searchPlaceholder: "すべての列から絞り込む",
  clearSearch: "検索を消す",
  clearFilters: "すべて解除",
  removeFilter: (label) => `絞り込みを解除: ${label}`,
  columns: "列",
  showAllColumns: "すべて表示",
  sortAscending: "昇順に並べ替え",
  sortDescending: "降順に並べ替え",
  addSortAscending: "次の順で昇順に並べ替え",
  addSortDescending: "次の順で降順に並べ替え",
  clearSort: "並べ替えを解除",
  filter: "絞り込み…",
  filterBy: (column) => `${column} で絞り込み`,
  statistics: "列の統計",
  hideColumn: "列を隠す",
  freezeUpTo: "この列までを固定",
  unfreeze: "列の固定を解除",
  autoFit: "幅を内容に合わせる",
  copy: "コピー",
  copyWithHeaders: "見出しを含めてコピー",
  copyAsMarkdown: "Markdown の表としてコピー",
  copyColumnName: "列名をコピー",
  copied: (cells) => `${cells} 個のセルをコピーしました`,
  copyTooLarge: (limit) => `コピーできるのは ${limit} セルまでです。`,
  copyFailed: "クリップボードに書き込めませんでした。",
  copyRanges: "複数の範囲をまとめてコピーできるのは、行または列が同じ範囲だけです。",
  copyCanceled: "コピーを取り消しました。",
  copying: "コピーしています…（Esc で取り消し）",
  filterToValue: "この値で絞り込む",
  excludeValue: "この値を除く",
  inspectCell: "値の全体を表示",
  shownAs: "表示",
  close: "閉じる",
  apply: "適用",
  clear: "解除",
  cancel: "キャンセル",
  selectAll: "（すべて選択）",
  blank: "（空白）",
  valuesTruncated: (shown) => `多い順に ${shown} 件を表示しています。ほかの値は検索してください。`,
  valuesSearch: "値を検索",
  condition: "条件",
  conditionNone: "なし",
  conditions: "条件…",
  conditionsTitle: "絞り込み条件",
  matchAll: "すべてを満たす（AND）",
  matchAny: "いずれかを満たす（OR）",
  and: "かつ",
  or: "または",
  addCondition: "条件を追加",
  addGroup: "グループを追加",
  removeCondition: "条件を削除",
  removeGroup: "グループを削除",
  noConditions: "条件はありません。条件を追加すると行を絞り込みます。",
  conditionColumn: "列",
  oneOf: "値のいずれか",
  noneOf: "値のいずれでもない",
  addAnd: "条件を追加（AND）…",
  addOr: "条件を追加（OR）…",
  inConditions: "この列は絞り込み条件でも使われています。",
  editConditions: "条件を編集…",
  operators: {
    eq: "等しい",
    ne: "等しくない",
    lt: "より小さい",
    le: "以下",
    gt: "より大きい",
    ge: "以上",
    between: "範囲",
    contains: "を含む",
    notContains: "を含まない",
    startsWith: "で始まる",
    endsWith: "で終わる",
    equals: "と等しい",
    notEquals: "と等しくない",
    blank: "空白",
    notBlank: "空白以外",
  },
  value: "値",
  minimum: "下限",
  maximum: "上限",
  matchCase: "大文字と小文字を区別",
  find: "検索",
  findPlaceholder: "表の中を検索",
  findNext: "次を検索",
  findPrevious: "前を検索",
  notFound: "見つかりません",
  searching: "検索しています…",
  stats: {
    rows: "行数",
    nulls: "空白",
    distinct: "種類",
    approximate: "概数",
    min: "最小",
    max: "最大",
    mean: "平均",
    stddev: "標準偏差",
    quartiles: "四分位",
    length: "文字数",
    histogram: "分布",
    top: "多い値",
  },
  summary: {
    count: "データの個数",
    numericCount: "数値の個数",
    sum: "合計",
    average: "平均",
    min: "最小",
    max: "最大",
  },
  types: {
    integer: "整数",
    bigint: "整数",
    float: "数値",
    decimal: "小数",
    boolean: "真偽値",
    string: "文字列",
    date: "日付",
    time: "時刻",
    timestamp: "日時",
    timestamptz: "日時（時差）",
    interval: "期間",
    uuid: "UUID",
    binary: "バイナリ",
    list: "リスト",
    struct: "構造",
    map: "マップ",
    json: "JSON",
    unknown: "その他",
  },
  sortedBy: (columns) => `並べ替え: ${columns}`,
  filtered: "絞り込み中",
  cell: (row, column) => `${row} 行目、${column}`,
  originalRow: (row) => `ファイルの ${row} 行目`,
  checkAllRows: "すべての行を選択",
  checkRow: (row) => `${row} 行目を選択`,
  rowChecked: (row) => `${row} 行目を選択しました`,
  rowUnchecked: (row) => `${row} 行目の選択を外しました`,
  rowsChecked: (count) => (count === null ? "条件に合う行を選択中" : `${number(count)} 行を選択中`),
  rowsUnchecked: "行の選択をすべて外しました",
  uncheckAllRows: "行の選択をすべて外す",
  textTruncated: "長い文字列は表の中では途中まで表示します。全体は「値の全体を表示」で読めます。",
  detailLabel: "行の詳細",
  detailTitle: (row) => `${row} 行目`,
  showDetail: "行の詳細を表示",
  detailFailed: "行を読み込めませんでした。",
  detailHidden: "非表示",
  detailEmpty: "表示する行がありません。",
  notes: {
    all_varchar: "列の型に合わない行があったため、すべての列を文字列として読み込みました。",
    invalid_utf8_replaced: "読めない文字を � に置き換えました。",
    "encoding:shift_jis": "Shift_JIS から変換して表示しています。",
    "encoding:euc-jp": "EUC-JP から変換して表示しています。",
    "encoding:latin-1": "Latin-1 から変換して表示しています。",
    "encoding:utf-16": "UTF-16 から変換して表示しています。",
    merged_cells: "結合セルの値は先頭のセルにだけ表示しています。",
    formulas_without_values: "計算結果が保存されていない数式があり、空欄で表示しています。",
  },
  export: "書き出し",
  exportFormat: "形式",
  exportFormats: { csv: "CSV", tsv: "TSV", parquet: "Parquet", json: "JSON", xlsx: "Excel（.xlsx）" },
  exportRows: "行",
  exportViewRows: (count) => `現在のビュー：${count} 行（表示中の絞り込み・並べ替えのとおり）`,
  exportTableRows: (count) => `表全体：${count} 行（ファイルの順）`,
  exportColumns: "列",
  exportVisibleColumns: (count) => `表示中の列（表示順、${count} 列）`,
  exportAllColumns: (count) => `すべての列（${count} 列）`,
  exportDisplaySettings: "列の表示名を見出しに使い、Excel では数値・日時の書式も付ける",
  exportFileName: "ファイル名",
  exportSave: "保存",
  exportDownload: "ダウンロード",
  exportSaveHint: "ファイルはサーバーが書き出します。",
  exportDownloadHint: "ファイルはブラウザーでダウンロードします。",
  exporting: "書き出しています…",
  exportCancelled: "書き出しを取り消しました。",
  exportInterrupted: "書き出し中に表が変わりました。もう一度書き出してください。",
  exportFailed: (message) => `書き出せませんでした：${message}`,
  exported: (rows, target) => `${rows} 行を ${target} に書き出しました。`,
  exportXlsxRows: (rows) => `Excel のシートは ${rows} 行までです。行を絞り込むか、別の形式を選んでください。`,
  exportXlsxColumns: (columns) => `Excel のシートは ${columns} 列までです。列を隠すか、別の形式を選んでください。`,
  editCell: "セルを編集",
  clearCells: "内容を消去",
  editorLabel: (cell) => `${cell} を編集`,
  editHint: "Enter で確定・Esc で取消・Alt+Enter で改行",
  editChecking: "確認しています…",
  editInvalid: {
    integer: "整数を入力してください。",
    range: "この列の範囲を超える数値です。",
    number: "数値を入力してください。",
    decimal: "指数を使わない小数で入力してください。",
    scale: "この列で使える小数点以下の桁数を超えています。",
    precision: "この列で使える桁数を超えています。",
    boolean: "true か false を入力してください。",
    date: "日付を yyyy-mm-dd の形で入力してください。",
    time: "時刻を hh:mm か hh:mm:ss の形で入力してください。",
    timestamp: "日時を yyyy-mm-dd hh:mm:ss の形で入力してください。",
    uuid: "UUID を入力してください。",
    json: "正しい JSON を入力してください。",
    type: "この型の値は編集できません。",
  },
  editReadOnly: "この列は読み取り専用です。",
  editProblems: (cells, first) => `${cells} 個のセルに値を入れられません。${first}`,
  editTooLarge: (limit) => `一度に変更できるのは ${limit} セルまでです。`,
  editSaving: (cells) => `${cells} セルを保存しています…`,
  editSaved: (cells) => `${cells} セルを保存しました。`,
  editFailed: (message) => `保存できませんでした：${message}`,
  editConflict: "保存できませんでした：その間にセルが変更されました。現在の値を表示しています。",
  editRevisionChanged: "保存できませんでした：表が読み直され、行が別のレコードを指している可能性があります。",
  editOverwrite: "上書き",
  editDiscard: "破棄",
};

/** Picks the built-in messages for a locale ("ja…" → Japanese, otherwise English). */
export function messagesFor(locale: string | undefined): Messages {
  return locale?.toLowerCase().startsWith("ja") ? ja : en;
}
