import type { MeasureName } from "vastgrid-spec";
import type { FilterOperator } from "../core/filters.js";
import type { Statistic } from "../core/measures.js";

/** The texts of the grid's UI. Hosts replace any of them with the `messages` prop. */
export interface GridMessages {
  grid: string;
  rows: (count: string) => string;
  loading: string;
  reading: string;
  failed: (message: string) => string;
  cell: (row: string, column: string) => string;
  count: (count: string) => string;
  sum: (sum: string) => string;
  average: (average: string) => string;
  copied: (cells: string) => string;
  search: string;
  /** The cell editor's label. */
  editing: (row: string, column: string) => string;
  /** How the editor saves and leaves, for screen readers. */
  editorHint: string;
  readOnly: string;
  invalidValue: (column: string) => string;
  /** The button that saves the written cells into the file. */
  save: string;
  saving: string;
  saved: (records: string) => string;
  /** Written cells that the file does not hold yet. */
  unsaved: (cells: string) => string;
  /** The file changed on disk since it was read: the save was refused, and the written cells are kept. */
  fileChanged: string;
  saveUnsupported: string;
  /** The file changed on disk while cells were written: they are kept, and the file is not read again. */
  changedOnDisk: string;
  reload: string;
  /** Reading the file again drops the cells written into the table as it was read. */
  discardAndReload: string;
  /** The menu that exports the view (§6.6), its choices, and what an export did. */
  export: string;
  exportFormats: Record<string, string>;
  exportView: string;
  exportTable: string;
  exportAllColumns: string;
  exporting: string;
  exported: (rows: string) => string;
  /** The menu of derived columns written as formulas (§4.11), and its fields and buttons. */
  formulas: string;
  newFormula: string;
  formulaName: string;
  formula: string;
  formulaExample: string;
  addFormula: string;
  applyFormula: string;
  removeFormula: string;
  /** The menu of a column (§6.2, §6.3): its label, sorting, filtering, pins, width and hiding. */
  columnMenu: (column: string) => string;
  sortAscending: string;
  sortDescending: string;
  thenSortAscending: string;
  thenSortDescending: string;
  clearSort: string;
  filter: string;
  filterBy: (column: string) => string;
  clearFilter: string;
  pinLeft: string;
  pinRight: string;
  unpin: string;
  autoFit: string;
  hideColumn: string;
  showAllColumns: string;
  /** The filter of a column: a list of its values with check boxes, or a condition. */
  valuesSearch: string;
  selectAll: string;
  blank: string;
  valuesTruncated: (shown: string) => string;
  condition: string;
  conditionNone: string;
  operators: Record<FilterOperator, string>;
  value: string;
  minimum: string;
  maximum: string;
  /** The column has conditions that the menu does not show; applying the menu's filter replaces them. */
  otherConditions: string;
  back: string;
  apply: string;
  /** The statistics of a column, over the rows of the view. */
  statistics: string;
  statisticsOf: (column: string) => string;
  statisticNames: Record<Statistic["kind"] | "nulls", string>;
  /** The total of a column in the totals row (§5.1), and the names of the measures (§4.5). */
  total: string;
  noTotal: string;
  measureNames: Record<MeasureName, string>;
  /** Grouping rows (§6.2): from a column's menu, and the toolbar's menu of keys and measures. */
  groupByColumn: string;
  removeFromGroups: string;
  ungroup: string;
  groups: string;
  groupKeys: string;
  addKey: string;
  measures: string;
  addMeasure: string;
  measureColumn: string;
  allRows: string;
  remove: (item: string) => string;
  /** The pivot of the groups (§4.6): the columns whose values become columns. */
  pivotBy: string;
  addPivot: string;
  /** The conditions menu (§6.2.1): groups of conditions across columns. */
  conditions: string;
  conditionsCount: (count: string) => string;
  conditionsTitle: string;
  conditionColumn: string;
  matchLabel: string;
  matchAll: string;
  matchAny: string;
  noConditions: string;
  addCondition: string;
  addGroup: string;
  removeGroup: string;
  removeCondition: string;
  invalidCondition: string;
  clearConditions: string;
  /** The columns menu (§6.3): every column of the view, shown or hidden, in order. */
  columns: string;
  findColumn: string;
  moveUp: (column: string) => string;
  moveDown: (column: string) => string;
  pinned: Record<"left" | "right", string>;
}

const en: GridMessages = {
  grid: "Data table",
  rows: (count) => `${count} rows`,
  loading: "Loading…",
  reading: "Reading the view…",
  failed: (message) => `Failed: ${message}`,
  cell: (row, column) => `Row ${row}, ${column}`,
  count: (count) => `Count ${count}`,
  sum: (sum) => `Sum ${sum}`,
  average: (average) => `Average ${average}`,
  copied: (cells) => `Copied ${cells} cells`,
  search: "Search",
  editing: (row, column) => `Editing row ${row}, ${column}`,
  editorHint: "Enter saves, Esc cancels, Alt+Enter starts a new line",
  readOnly: "This cell is not written.",
  invalidValue: (column) => `This is not a value of ${column}.`,
  save: "Save",
  saving: "Saving…",
  saved: (records) => `Saved rows: ${records}`,
  unsaved: (cells) => `Unsaved ${cells}`,
  fileChanged:
    "Not saved: the file was changed by someone else. Your edits are kept; open the file again to see the changes.",
  saveUnsupported: "This file cannot be saved.",
  changedOnDisk: "The file changed on disk. Your unsaved edits are kept.",
  reload: "Reload",
  discardAndReload: "Discard edits and reload",
  export: "Export",
  exportFormats: { csv: "CSV", tsv: "TSV", xlsx: "Excel (.xlsx)", parquet: "Parquet", json: "JSON" },
  exportView: "Rows of the view",
  exportTable: "Whole table",
  exportAllColumns: "Hidden columns too",
  exporting: "Exporting…",
  exported: (rows) => `Exported ${rows} rows`,
  formulas: "Formulas",
  newFormula: "New column",
  formulaName: "Column name",
  formula: "Formula",
  formulaExample: "qty * price",
  addFormula: "Add",
  applyFormula: "Apply",
  removeFormula: "Remove",
  columnMenu: (column) => `${column} column menu`,
  sortAscending: "Sort ascending",
  sortDescending: "Sort descending",
  thenSortAscending: "Then sort ascending",
  thenSortDescending: "Then sort descending",
  clearSort: "Clear sort",
  filter: "Filter…",
  filterBy: (column) => `Filter ${column}`,
  clearFilter: "Clear filter",
  pinLeft: "Freeze at the left",
  pinRight: "Freeze at the right",
  unpin: "Unfreeze",
  autoFit: "Fit width to content",
  hideColumn: "Hide column",
  showAllColumns: "Show all columns",
  valuesSearch: "Search values",
  selectAll: "(Select all)",
  blank: "(Blank)",
  valuesTruncated: (shown) => `Showing the ${shown} most common values. Search to find others.`,
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
    blank: "Is blank",
    notBlank: "Is not blank",
  },
  value: "Value",
  minimum: "From",
  maximum: "To",
  otherConditions: "This column has other conditions. Applying replaces them.",
  back: "Back",
  apply: "Apply",
  statistics: "Statistics…",
  statisticsOf: (column) => `Statistics of ${column}`,
  statisticNames: {
    rows: "Rows",
    values: "Values",
    nulls: "Empty",
    distinct: "Distinct",
    min: "Minimum",
    max: "Maximum",
    sum: "Sum",
    average: "Average",
    median: "Median",
    stddev: "Standard deviation",
  },
  total: "Total",
  noTotal: "No total",
  measureNames: {
    count: "Count",
    count_distinct: "Distinct count",
    sum: "Sum",
    avg: "Average",
    stddev: "Standard deviation",
    min: "Minimum",
    max: "Maximum",
    quantile: "Quantile",
  },
  groupByColumn: "Group by this column",
  removeFromGroups: "Stop grouping by this column",
  ungroup: "Ungroup",
  groups: "Group",
  groupKeys: "Group by",
  addKey: "Add a column…",
  measures: "Measures",
  addMeasure: "Add",
  measureColumn: "Column",
  allRows: "(rows)",
  remove: (item) => `Remove ${item}`,
  pivotBy: "Columns from values of",
  addPivot: "Add a column…",
  conditions: "Conditions",
  conditionsCount: (count) => `Conditions (${count})`,
  conditionsTitle: "Filter conditions",
  conditionColumn: "Column",
  matchLabel: "Match",
  matchAll: "All of these (AND)",
  matchAny: "Any of these (OR)",
  noConditions: "No conditions. Add one to filter the rows.",
  addCondition: "Add condition",
  addGroup: "Add group",
  removeGroup: "Remove group",
  removeCondition: "Remove condition",
  invalidCondition: "A value is not a value of its column.",
  clearConditions: "Clear all",
  columns: "Columns",
  findColumn: "Find a column",
  moveUp: (column) => `Move ${column} left`,
  moveDown: (column) => `Move ${column} right`,
  pinned: { left: "Frozen left", right: "Frozen right" },
};

const ja: GridMessages = {
  grid: "データの表",
  rows: (count) => `${count} 行`,
  loading: "読み込み中…",
  reading: "ビューを読んでいます…",
  failed: (message) => `失敗しました: ${message}`,
  cell: (row, column) => `${row} 行目・${column}`,
  count: (count) => `個数 ${count}`,
  sum: (sum) => `合計 ${sum}`,
  average: (average) => `平均 ${average}`,
  copied: (cells) => `${cells} セルをコピーしました`,
  search: "検索",
  editing: (row, column) => `${row} 行目・${column} を編集中`,
  editorHint: "Enter で保存、Esc で取り消し、Alt+Enter で改行",
  readOnly: "このセルは書き込めません。",
  invalidValue: (column) => `${column} の値として読めません。`,
  save: "保存",
  saving: "保存しています…",
  saved: (records) => `${records} 行を保存しました`,
  unsaved: (cells) => `未保存 ${cells}`,
  fileChanged:
    "保存しませんでした: ファイルがほかで変更されています。編集は残っています。変更を見るにはファイルを開き直してください。",
  saveUnsupported: "このファイルは保存できません。",
  changedOnDisk: "ディスク上のファイルが変更されました。未保存の編集は残っています。",
  reload: "再読み込み",
  discardAndReload: "編集を破棄して再読み込み",
  export: "書き出し",
  exportFormats: { csv: "CSV", tsv: "TSV", xlsx: "Excel (.xlsx)", parquet: "Parquet", json: "JSON" },
  exportView: "ビューの行",
  exportTable: "表全体",
  exportAllColumns: "非表示の列も含める",
  exporting: "書き出しています…",
  exported: (rows) => `${rows} 行を書き出しました`,
  formulas: "計算列",
  newFormula: "新しい列",
  formulaName: "列名",
  formula: "式",
  formulaExample: "qty * price",
  addFormula: "追加",
  applyFormula: "適用",
  removeFormula: "削除",
  columnMenu: (column) => `${column} 列のメニュー`,
  sortAscending: "昇順に並べ替え",
  sortDescending: "降順に並べ替え",
  thenSortAscending: "次の順で昇順に並べ替え",
  thenSortDescending: "次の順で降順に並べ替え",
  clearSort: "並べ替えを解除",
  filter: "絞り込み…",
  filterBy: (column) => `${column} で絞り込み`,
  clearFilter: "絞り込みを解除",
  pinLeft: "左端に固定",
  pinRight: "右端に固定",
  unpin: "固定を解除",
  autoFit: "幅を内容に合わせる",
  hideColumn: "列を隠す",
  showAllColumns: "すべての列を表示",
  valuesSearch: "値を検索",
  selectAll: "（すべて選択）",
  blank: "（空白）",
  valuesTruncated: (shown) => `多い順に ${shown} 件を表示しています。ほかの値は検索してください。`,
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
    blank: "空白",
    notBlank: "空白以外",
  },
  value: "値",
  minimum: "下限",
  maximum: "上限",
  otherConditions: "この列にはほかの条件があります。適用すると置き換えます。",
  back: "戻る",
  apply: "適用",
  statistics: "統計…",
  statisticsOf: (column) => `${column} の統計`,
  statisticNames: {
    rows: "行数",
    values: "値の数",
    nulls: "空",
    distinct: "異なる値の数",
    min: "最小",
    max: "最大",
    sum: "合計",
    average: "平均",
    median: "中央値",
    stddev: "標準偏差",
  },
  total: "集計行",
  noTotal: "集計しない",
  measureNames: {
    count: "個数",
    count_distinct: "異なる値の数",
    sum: "合計",
    avg: "平均",
    stddev: "標準偏差",
    min: "最小",
    max: "最大",
    quantile: "分位数",
  },
  groupByColumn: "この列でグループ化",
  removeFromGroups: "この列でのグループ化をやめる",
  ungroup: "グループ化を解除",
  groups: "グループ",
  groupKeys: "グループ化する列",
  addKey: "列を追加…",
  measures: "集計",
  addMeasure: "追加",
  measureColumn: "列",
  allRows: "（行）",
  remove: (item) => `${item} を削除`,
  pivotBy: "値を列にする列",
  addPivot: "列を追加…",
  conditions: "条件",
  conditionsCount: (count) => `条件（${count}）`,
  conditionsTitle: "絞り込み条件",
  conditionColumn: "列",
  matchLabel: "一致",
  matchAll: "すべてを満たす（AND）",
  matchAny: "いずれかを満たす（OR）",
  noConditions: "条件はありません。条件を追加すると行を絞り込みます。",
  addCondition: "条件を追加",
  addGroup: "グループを追加",
  removeGroup: "グループを削除",
  removeCondition: "条件を削除",
  invalidCondition: "列の値として読めない値があります。",
  clearConditions: "すべて解除",
  columns: "列",
  findColumn: "列を検索",
  moveUp: (column) => `${column} を左へ移動`,
  moveDown: (column) => `${column} を右へ移動`,
  pinned: { left: "左に固定", right: "右に固定" },
};

/** The built-in texts for a language tag: Japanese for `ja`, English otherwise. */
export function messagesFor(locale: string | undefined): GridMessages {
  return locale?.toLowerCase().startsWith("ja") ? ja : en;
}
