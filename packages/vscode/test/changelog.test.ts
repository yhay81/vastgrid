// The extension's CHANGELOG.md (scripts/changelog.mjs): the repository's items about the extension, by version.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { extensionChangelog } from "../scripts/changelog.mjs";

test("the extension's changelog keeps the items about vastgrid-vscode, without its name when it is the only one", () => {
  const text = [
    "# Changelog",
    "",
    "## 1.1.0 — 2026-11-02",
    "",
    "### New",
    "",
    "- `vastgrid-vscode`: the editor has a button, as [the guide](docs/vscode.md) says.",
    "- `vastgrid-cli`: the command starts faster",
    "  than before.",
    "- `vastgrid-cli` and `vastgrid-vscode`: both follow the language",
    "  of the host.",
    "",
    "### Fixes",
    "",
    "- `vastgrid-js`: a fix of the engine.",
    "",
    "## 1.0.0 — 2026-11-01",
    "",
    "### New",
    "",
    "- `vastgrid`: the grid.",
    "",
  ].join("\n");
  assert.equal(
    extensionChangelog(text),
    [
      "# Changelog",
      "",
      "The changes to the extension, from the repository's [CHANGELOG.md](https://github.com/yhay81/vastgrid/blob/main/CHANGELOG.md).",
      "",
      "## 1.1.0 — 2026-11-02",
      "",
      "### New",
      "",
      "- The editor has a button, as [the guide](https://github.com/yhay81/vastgrid/blob/main/docs/vscode.md) says.",
      "- `vastgrid-cli` and `vastgrid-vscode`: both follow the language",
      "  of the host.",
      "",
    ].join("\n"),
  );
});

test("the extension's changelog from the repository's CHANGELOG.md has versions and absolute links", async () => {
  const changelog = extensionChangelog(await readFile(new URL("../../../CHANGELOG.md", import.meta.url), "utf8"));
  assert.match(changelog, /^## /m);
  assert.doesNotMatch(changelog, /\]\((?!https?:|#)/);
});
