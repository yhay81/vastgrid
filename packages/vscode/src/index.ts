/**
 * The side of vastgrid's VS Code extension that uses no VS Code API (docs/vscode.md): a file read by the DuckDB
 * engine for the webviews that show it.
 */
export type { HostMessage, ViewMessage } from "./messages.js";
export {
  type FileView,
  isSavableFile,
  type KeptFile,
  TableFile,
  TableFileError,
  type TableFileOptions,
} from "./table-file.js";
