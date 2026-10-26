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
};

/** The built-in texts for a language tag: Japanese for `ja`, English otherwise. */
export function messagesFor(locale: string | undefined): GridMessages {
  return locale?.toLowerCase().startsWith("ja") ? ja : en;
}
