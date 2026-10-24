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
};

/** The built-in texts for a language tag: Japanese for `ja`, English otherwise. */
export function messagesFor(locale: string | undefined): GridMessages {
  return locale?.toLowerCase().startsWith("ja") ? ja : en;
}
