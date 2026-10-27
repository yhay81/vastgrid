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
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      for (const [, provider] of providers) provider.trust();
    }),
    vscode.commands.registerCommand("vastgrid.open", async (uri?: vscode.Uri) => {
      const target = uri ?? activeUri();
      if (!target) return;
      const viewType = TEXT_FILE.test(target.path) ? VIEW_TYPES.text : VIEW_TYPES.table;
      await vscode.commands.executeCommand("vscode.openWith", target, viewType);
    }),
    // The sheet of a workbook, chosen from the command palette as from the bar above the grid.
    vscode.commands.registerCommand("vastgrid.sheet", async (uri?: vscode.Uri, name?: string) => {
      const target = uri ?? activeUri();
      const view = target && providers.map(([, provider]) => provider.view(target)).find(Boolean);
      if (!view) return;
      const { names, sheet } = view.sheets();
      if (names.length < 2) {
        if (name === undefined)
          void vscode.window.showInformationMessage(vscode.l10n.t("This file has no other sheets."));
        else throw new Error(`The file has no sheet ${JSON.stringify(name)}.`);
        return;
      }
      const chosen =
        name ??
        (
          await vscode.window.showQuickPick(
            names.map((label) => ({ label, ...(label === sheet ? { description: vscode.l10n.t("shown") } : {}) })),
            { placeHolder: vscode.l10n.t("Choose a sheet") },
          )
        )?.label;
      if (chosen === undefined || chosen === sheet) return;
      if (!names.includes(chosen)) throw new Error(`The file has no sheet ${JSON.stringify(chosen)}.`);
      view.showSheet(chosen);
    }),
  );
  return {
    dispatch: (uri, command) => {
      const open = providers.find(([, provider]) => provider.has(uri));
      return (open ?? providers[0])[1].dispatch(uri, command);
    },
  };
}

/** The file of the active tab. */
function activeUri(): vscode.Uri | undefined {
  return (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined)?.uri;
}

export function deactivate() {}
