/**
 * The side of vastgrid's VS Code extension that uses no VS Code API (docs/vscode.md): a file read by the DuckDB
 * engine for the webviews that show it.
 */

export { newSteps } from "./history.js";
export type { HostMessage, ViewMessage } from "./messages.js";
export {
  type Backup,
  type FileKey,
  type FileView,
  isSavableFile,
  type KeptFile,
  readBackup,
  TableFile,
  TableFileError,
  type TableFileOptions,
} from "./table-file.js";
