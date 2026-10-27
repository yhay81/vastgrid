/**
 * The messages between the extension and a webview besides those of §8 (docs/vscode.md), which both sides import.
 */

/** Messages of the extension to a webview that are neither responses nor events of §8. */
export type HostMessage =
  /** The engine started again (the file was reverted): open the file anew, keeping the document. */
  | { vastgrid: "restart" }
  /** Show this sheet of the workbook, as the bar above the grid does. */
  | { vastgrid: "sheet"; name: string }
  /** Apply a command of §6 to the grid, and answer it. */
  | { vastgrid: "dispatch"; call: number; command: unknown };

/** Messages of a webview to the extension that are not requests of §8. */
export type ViewMessage =
  /** The page (re)started: the handles that it opened before are closed. */
  | { vastgrid: "ready" }
  /** The page's grid takes the extension's commands, or stopped taking them (another grid replaces it). */
  | { vastgrid: "listening"; on: boolean }
  /** An error that the page did not catch, for the extension's log. */
  | { vastgrid: "error"; message: string }
  /** The person pressed the key that saves, undoes or redoes: VS Code does it, for the file. */
  | { vastgrid: "save" | "undo" | "redo" }
  /** The sheets that the bar above the grid offers (none for a file without sheets), and the one shown. */
  | { vastgrid: "sheets"; names: string[]; sheet?: string }
  /** The grid wrote cells, as a new step of its history (§7.4): an edit on VS Code's stack. */
  | { vastgrid: "edit" }
  /** The outcome of a `dispatch`. */
  | { vastgrid: "answer"; call: number; ok: boolean; output?: unknown; error?: { code: string; message: string } };
