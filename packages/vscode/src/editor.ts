/**
 * vastgrid's custom editor (docs/vscode.md): a `TableFile` for each file that VS Code opens with it, and a webview
 * with `DataGrid` for each editor of the file. VS Code's dirty state, Save, Save As and Revert act on the file;
 * undo and redo are the grid's, for the cells that each editor wrote.
 */
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { type FileView, TableFile } from "./table-file.js";

/** The editors' view types: one that opens binary files by default, one offered for text files. */
export const VIEW_TYPES = { table: "vastgrid.table", text: "vastgrid.text" } as const;

/** The files that open as text by default, which vastgrid is offered for. */
export const TEXT_FILE = /\.(csv|tsv|tab|jsonl|ndjson)(\.gz|\.zst)?$/i;

class TableDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    readonly file: TableFile,
  ) {}

  dispose() {
    void this.file.dispose();
  }
}

interface Editor {
  panel: vscode.WebviewPanel;
  view: FileView;
}

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string,
  );
}

export class TableEditorProvider implements vscode.CustomEditorProvider<TableDocument> {
  private readonly changes = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<TableDocument>>();
  readonly onDidChangeCustomDocument = this.changes.event;
  /** The editors of each file, by its URI. */
  private readonly editors = new Map<string, Set<Editor>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async openCustomDocument(uri: vscode.Uri): Promise<TableDocument> {
    if (uri.scheme !== "file") throw new Error("vastgrid opens files on disk only.");
    // A backup holds nothing: written cells do not outlive the window (docs/vscode.md).
    const file = new TableFile(uri.fsPath, {
      tempDirectory: path.join(os.tmpdir(), "vastgrid-vscode"),
      editable: vscode.workspace.isTrusted,
      exportTo: async (kept) => {
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(uri, "..", kept.fileName),
          saveLabel: vscode.l10n.t("Export"),
        });
        if (!target) return false;
        await vscode.workspace.fs.copy(vscode.Uri.file(kept.path), target, { overwrite: true });
        return true;
      },
      log: (message, error) => this.log.error(message, error),
    });
    const document = new TableDocument(uri, file);
    file.onWrite(() => this.changes.fire({ document }));
    file.onSaveKey(() => void vscode.workspace.save(uri));
    return document;
  }

  async resolveCustomEditor(document: TableDocument, panel: vscode.WebviewPanel): Promise<void> {
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.webview.html = this.html(panel.webview, document);
    const view = document.file.connect((message) => void panel.webview.postMessage(message));
    const editor: Editor = { panel, view };
    const key = document.uri.toString();
    const editors = this.editors.get(key) ?? new Set();
    editors.add(editor);
    this.editors.set(key, editors);
    const receiving = panel.webview.onDidReceiveMessage((message) => view.receive(message));
    panel.onDidDispose(() => {
      receiving.dispose();
      view.dispose();
      editors.delete(editor);
      if (editors.size === 0) this.editors.delete(key);
    });
  }

  private html(webview: vscode.Webview, document: TableDocument) {
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css"));
    const nonce = randomBytes(16).toString("base64");
    const source = webview.cspSource;
    const csp = [
      "default-src 'none'",
      `img-src ${source} data: blob:`,
      `style-src ${source} 'unsafe-inline'`,
      `font-src ${source}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const locale = vscode.env.language.toLowerCase().startsWith("ja") ? "ja" : "en";
    return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${styles}" />
    <title>${escapeHtml(document.file.ref)}</title>
  </head>
  <body>
    <div id="root" data-ref="${escapeHtml(document.file.ref)}" data-locale="${locale}" data-editable="${document.file.editable}"></div>
    <script type="module" nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
  }

  async saveCustomDocument(document: TableDocument, cancellation: vscode.CancellationToken): Promise<void> {
    await document.file.save(signalOf(cancellation));
  }

  async saveCustomDocumentAs(
    document: TableDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    if (destination.scheme !== "file") throw new Error("vastgrid saves files on disk only.");
    await document.file.saveAs(destination.fsPath, signalOf(cancellation));
  }

  async revertCustomDocument(document: TableDocument): Promise<void> {
    await document.file.revert();
  }

  async backupCustomDocument(
    _document: TableDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    return { id: context.destination.toString(), delete: () => {} };
  }

  /** Whether the file has an editor of this provider. */
  has(uri: vscode.Uri): boolean {
    return this.editors.has(uri.toString());
  }

  /** Applies a command of §6 in an editor of the file: the active one, or the first. */
  dispatch(uri: vscode.Uri, command: unknown): Promise<unknown> {
    const editors = [...(this.editors.get(uri.toString()) ?? [])];
    const editor = editors.find(({ panel }) => panel.active) ?? editors[0];
    if (!editor) return Promise.reject(new Error(`${uri.toString()} is not open in vastgrid.`));
    return editor.view.dispatch(command);
  }
}

function signalOf(cancellation: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (cancellation.isCancellationRequested) controller.abort();
  else cancellation.onCancellationRequested(() => controller.abort());
  return controller.signal;
}
