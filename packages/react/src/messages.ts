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
};

/** Picks the built-in messages for a locale ("ja…" → Japanese, otherwise English). */
export function messagesFor(locale: string | undefined): Messages {
  return locale?.toLowerCase().startsWith("ja") ? ja : en;
}
