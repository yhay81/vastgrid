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
  /** A write that failed (§6.6): why, and the buttons that send it again, write over the cells or forget it. */
  writeFailed: (message: string) => string;
  writeConflict: string;
  writeRevisionChanged: string;
  retry: string;
  overwrite: string;
  discard: string;
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
  /** A column's format (§5.1): label, alignment, wrapping, number and date formats, and conditional colors. */
  format: string;
  formatOf: (column: string) => string;
  columnLabel: string;
  alignment: string;
  alignments: Record<"auto" | "left" | "center" | "right", string>;
  wrapText: string;
  numberFormat: string;
  numberStyles: Record<"none" | "decimal" | "percent" | "currency", string>;
  currency: string;
  invalidCurrency: string;
  fractionDigits: string;
  grouping: string;
  datePattern: string;
  conditionalColors: string;
  textColor: string;
  backgroundColor: string;
  ruleDescription: string;
  addRule: string;
  removeRule: string;
  clearFormat: string;
  /** The detail panel of the active row (§5.2). */
  details: string;
  detailOf: (row: string) => string;
  closeDetails: string;
  /** Checked rows (§5.2.1): how many, or that the view may not match them. */
  checkedRows: (count: string) => string;
  checkedUnknown: string;
  /** The find bar (⌘F) and the cell menu. */
  find: string;
  matchCase: string;
  findNext: string;
  findPrevious: string;
  closeFind: string;
  noMatches: string;
  cellMenu: string;
  copy: string;
  filterToValue: string;
  excludeValue: string;
  fullValue: string;
  close: string;
}

/** The grid's texts in English, which it shows unless the `messages` prop replaces them. */
export const en: GridMessages = {
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
  writeFailed: (message) => `Not written: ${message}`,
  writeConflict: "Not written: the cells were changed meanwhile. Their values now are shown.",
  writeRevisionChanged: "Not written: the table was read again, so its rows may be other records now.",
  retry: "Retry",
  overwrite: "Overwrite",
  discard: "Discard",
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
  format: "Format…",
  formatOf: (column) => `Format of ${column}`,
  columnLabel: "Label",
  alignment: "Alignment",
  alignments: { auto: "By type", left: "Left", center: "Center", right: "Right" },
  wrapText: "Wrap text",
  numberFormat: "Numbers",
  numberStyles: { none: "As they are", decimal: "Number", percent: "Percent", currency: "Currency" },
  currency: "Currency code",
  invalidCurrency: "This is not a currency code (such as JPY or USD).",
  fractionDigits: "Decimal places",
  grouping: "Group digits",
  datePattern: "Date pattern",
  conditionalColors: "Conditional colors",
  textColor: "Text",
  backgroundColor: "Background",
  ruleDescription: "What the colors mean",
  addRule: "Add rule",
  removeRule: "Remove rule",
  clearFormat: "Clear format",
  details: "Details",
  detailOf: (row) => `Row ${row}`,
  closeDetails: "Close details",
  checkedRows: (count) => `${count} checked`,
  checkedUnknown: "Some rows of this view may not be checked: filter as when they were checked, or clear the checks.",
  find: "Find",
  matchCase: "Match case",
  findNext: "Find next",
  findPrevious: "Find previous",
  closeFind: "Close find",
  noMatches: "No matches",
  cellMenu: "Cell menu",
  copy: "Copy",
  filterToValue: "Filter to this value",
  excludeValue: "Exclude this value",
  fullValue: "Show full value",
  close: "Close",
};
