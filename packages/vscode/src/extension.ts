/**
 * vastgrid's extension for VS Code (docs/vscode.md): table files open in a grid, read by DuckDB in the extension's
 * process. Other extensions (and the tests) get `dispatch`, which applies a command of §6 in an editor of a file.
 */
import * as vscode from "vscode";
import { TableEditorProvider, TEXT_FILE, VIEW_TYPES } from "./editor.js";

export interface VastgridApi {
  /** Applies a command of §6 in the grid of a file open in vastgrid, as its keys and menus do; its output. */
  dispatch(uri: vscode.Uri, command: unknown): Promise<unknown>;
}

export function activate(context: vscode.ExtensionContext): VastgridApi {
  const log = vscode.window.createOutputChannel("vastgrid", { log: true });
  // A provider for each view type: VS Code finds the documents of a provider's change events by its view type.
  const providers = [VIEW_TYPES.table, VIEW_TYPES.text].map(
    (viewType) => [viewType, new TableEditorProvider(context.extensionUri, log)] as const,
  );
  const options = {
    // A grid keeps its rows and place while its tab is hidden, and the file's engine serves every editor of it.
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: true,
  };
  context.subscriptions.push(
    log,
    ...providers.map(([viewType, provider]) => vscode.window.registerCustomEditorProvider(viewType, provider, options)),
    vscode.commands.registerCommand("vastgrid.open", async (uri?: vscode.Uri) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
      const target = uri ?? input?.uri;
      if (!target) return;
      const viewType = TEXT_FILE.test(target.path) ? VIEW_TYPES.text : VIEW_TYPES.table;
      await vscode.commands.executeCommand("vscode.openWith", target, viewType);
    }),
  );
  return {
    dispatch: (uri, command) => {
      const open = providers.find(([, provider]) => provider.has(uri));
      return (open ?? providers[0])[1].dispatch(uri, command);
    },
  };
}

export function deactivate() {}
