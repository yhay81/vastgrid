// The extension in VS Code (scripts/test-vscode.mjs): the editor's life with VS Code's commands, and the grid's
// commands through the extension's `dispatch`, which the page applies as its keys and menus do.
const assert = require("node:assert/strict");
const { readdir, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fails what does not settle within `ms`: a grid that never answers fails the test instead of stopping it. */
function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer: ${what}`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function eventually(check, what) {
  for (let tries = 0; tries < 150; tries++) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // Not yet.
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${what}`);
}

/** The tabs of vastgrid's editors of a file. */
function tabsOf(uri) {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString());
}

async function closeAll() {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

/** The engines' folders that are there now. */
async function engineFolders() {
  return readdir(path.join(os.tmpdir(), "vastgrid-vscode")).catch(() => []);
}

exports.run = async () => {
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const extension = vscode.extensions.getExtension("yhay81.vastgrid-vscode");
  const activated = await extension.activate();
  const api = {
    dispatch: (uri, command) => within(activated.dispatch(uri, command), 10_000, JSON.stringify(command)),
  };
  const csv = vscode.Uri.file(path.join(folder, "orders.csv"));
  const before = await engineFolders();

  /** Opens a file in vastgrid and waits for its grid to answer. */
  async function open(uri, viewType, column) {
    await vscode.commands.executeCommand("vscode.openWith", uri, viewType, column);
    await eventually(
      async () => (await api.dispatch(uri, { command: "select", row: 0, column: "id" })) === undefined,
      `the grid of ${uri.path}`,
    );
  }

  /** The text of a cell, as the grid copies it. */
  async function cellText(uri, row, column) {
    await api.dispatch(uri, { command: "select", row, column });
    return eventually(async () => (await api.dispatch(uri, { command: "copy" })).tsv, "the cell's value");
  }

  async function write(uri, row, column, text) {
    await api.dispatch(uri, { command: "select", row, column });
    await api.dispatch(uri, { command: "edit.begin", text });
    await api.dispatch(uri, { command: "edit.commit" });
  }

  // Open, edit, save: only the edited field changes, and the editor is no longer dirty.
  await open(csv, "vastgrid.text");
  assert.equal(await cellText(csv, 1, "region"), "US, east");
  await write(csv, 0, "price", "99.5");
  await eventually(() => tabsOf(csv)[0]?.isDirty, "the editor to be dirty");
  assert.equal(await cellText(csv, 0, "price"), "99.5");
  await vscode.workspace.save(csv);
  await eventually(() => !tabsOf(csv)[0]?.isDirty, "the editor to be saved");
  const saved = process.env.VASTGRID_TEST_CSV.replace("1,EU,10.5", "1,EU,99.5");
  assert.equal(await readFile(csv.fsPath, "utf8"), saved);

  // VS Code's Undo and Redo (its Edit menu, and the keys that the page gives it) undo and redo the grid's write: the
  // editor is dirty while the cells differ from the saved file.
  await write(csv, 0, "price", "77");
  await eventually(() => tabsOf(csv)[0]?.isDirty, "the editor to be dirty");
  // VS Code's Undo goes to a text field that has the focus first: the editor has it, as when the person uses it.
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  await vscode.commands.executeCommand("undo");
  await eventually(async () => (await cellText(csv, 0, "price")) === "99.5", "the undo of the write");
  await eventually(() => !tabsOf(csv)[0]?.isDirty, "the editor to be clean after the undo");
  await vscode.commands.executeCommand("redo");
  await eventually(async () => (await cellText(csv, 0, "price")) === "77.0", "the redo of the write");
  await eventually(() => tabsOf(csv)[0]?.isDirty, "the editor to be dirty after the redo");
  await vscode.commands.executeCommand("undo");
  await eventually(() => !tabsOf(csv)[0]?.isDirty, "the editor to be clean again");

  // A file changed on disk by someone else is not saved over: the editor stays dirty, and a revert reads the file.
  await write(csv, 2, "region", "JP");
  await eventually(() => tabsOf(csv)[0]?.isDirty, "the editor to be dirty");
  const theirs = saved.replace("3,EU,20", "3,EU,25");
  await writeFile(csv.fsPath, theirs);
  await assert.rejects(Promise.resolve(vscode.workspace.save(csv)), /changed by someone else/);
  assert.equal(await readFile(csv.fsPath, "utf8"), theirs);
  assert.equal(tabsOf(csv)[0]?.isDirty, true);
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await eventually(() => !tabsOf(csv)[0]?.isDirty, "the editor to be reverted");
  await eventually(async () => (await cellText(csv, 2, "price")) === "25.0", "the other's value after the revert");
  await writeFile(csv.fsPath, saved);

  // Open again: the saved value is read from the file.
  await closeAll();
  await open(csv, "vastgrid.text");
  assert.equal(await cellText(csv, 0, "price"), "99.5");

  // Revert drops the written cells.
  await write(csv, 2, "region", "JP");
  await eventually(() => tabsOf(csv)[0]?.isDirty, "the editor to be dirty");
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await eventually(() => !tabsOf(csv)[0]?.isDirty, "the editor to be reverted");
  await eventually(async () => (await cellText(csv, 2, "region")) === "EU", "the file's value after the revert");
  assert.equal(await readFile(csv.fsPath, "utf8"), saved);

  // Two editors of one file share its engine: what one writes, the other reads.
  await open(csv, "vastgrid.text", vscode.ViewColumn.Two);
  assert.equal(tabsOf(csv).length, 2);
  await write(csv, 1, "price", "31");
  await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
  // A float's text form (§2.4).
  await eventually(async () => (await cellText(csv, 1, "price")) === "31.0", "the other editor to read the write");
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await eventually(() => tabsOf(csv).every((tab) => !tab.isDirty), "the editors to be reverted");

  // TSV files are written like CSV files; JSON Lines, Parquet and Excel files are read, not written.
  const tsv = vscode.Uri.file(path.join(folder, "orders.tsv"));
  await open(tsv, "vastgrid.text");
  assert.equal(await cellText(tsv, 1, "region"), "US, east");
  await write(tsv, 2, "region", "JP");
  await eventually(() => tabsOf(tsv)[0]?.isDirty, "the TSV editor to be dirty");
  await vscode.workspace.save(tsv);
  await eventually(() => !tabsOf(tsv)[0]?.isDirty, "the TSV file to be saved");
  assert.equal(await readFile(tsv.fsPath, "utf8"), "id\tregion\tprice\n1\tEU\t10.5\n2\tUS, east\t30\n3\tJP\t20\n");
  for (const name of ["orders.jsonl", "orders.parquet", "orders.xlsx"]) {
    const uri = vscode.Uri.file(path.join(folder, name));
    await open(uri, name.endsWith(".jsonl") ? "vastgrid.text" : "vastgrid.table");
    assert.equal(await cellText(uri, 1, "region"), "US, east");
    await api.dispatch(uri, { command: "select", row: 0, column: "price" });
    await assert.rejects(api.dispatch(uri, { command: "edit.begin", text: "1" }), { code: "invalid_command" });
    assert.equal(tabsOf(uri)[0]?.isDirty, false);
  }

  // The sheet chosen in a workbook shows its last row.
  const sheets = vscode.Uri.file(path.join(folder, "sheets.xlsx"));
  await open(sheets, "vastgrid.table");
  assert.equal(await cellText(sheets, 2, "id"), "3");
  await eventually(async () => {
    await vscode.commands.executeCommand("vastgrid.sheet", sheets, "Large");
    return true;
  }, "the sheets of the workbook");
  await eventually(async () => (await cellText(sheets, 199_999, "id")) === "200000", "the last row of the sheet");
  assert.equal(await cellText(sheets, 199_999, "value"), String((199_999 * 7) % 1000));

  // Files of a million rows show their last row.
  for (const name of ["big.csv", "big.parquet"]) {
    const uri = vscode.Uri.file(path.join(folder, name));
    await open(uri, name.endsWith(".csv") ? "vastgrid.text" : "vastgrid.table");
    await eventually(async () => (await cellText(uri, 999_999, "id")) === "1000000", `the last row of ${name}`);
    assert.equal(await cellText(uri, 999_999, "value"), String((999_999 * 7) % 1000));
  }

  // Closing the editors closes the engines, with their folders.
  await closeAll();
  await eventually(
    async () => (await engineFolders()).filter((name) => !before.includes(name)).length === 0,
    "the engines' folders to be removed",
  );
};
