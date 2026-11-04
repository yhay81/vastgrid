import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

// The manifest's texts are in package.nls.json and package.nls.ja.json, the extension's in l10n/, and its files
// are in the package: these keep them from drifting apart.

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (name: string) => JSON.parse(readFileSync(path.join(root, name), "utf8"));
const manifest = json("package.json");

test("every text of the manifest is in English and in Japanese, and no other", () => {
  const keys = [...JSON.stringify(manifest).matchAll(/"%([^%"]+)%"/g)].map((match) => match[1]).sort();
  assert.ok(keys.length > 0);
  for (const name of ["package.nls.json", "package.nls.ja.json"]) {
    assert.deepEqual(Object.keys(json(name)).sort(), [...new Set(keys)], name);
  }
});

test("every text of the extension is in Japanese, and no other", () => {
  const source = path.join(root, "src");
  const texts = readdirSync(source)
    .filter((name) => name.endsWith(".ts"))
    .flatMap((name) => [...readFileSync(path.join(source, name), "utf8").matchAll(/l10n\.t\(\s*("(?:[^"\\]|\\.)*")/g)])
    .map((match): string => JSON.parse(match[1]));
  assert.ok(texts.length > 0);
  assert.equal(manifest.l10n, "./l10n");
  assert.deepEqual(Object.keys(json("l10n/bundle.l10n.ja.json")).sort(), [...new Set(texts)].sort());
});

test("the files that the manifest names are in the package", () => {
  const { commands, walkthroughs } = manifest.contributes;
  const files = [
    manifest.icon,
    ...commands.flatMap((command: { icon?: { light: string; dark: string } }) =>
      command.icon ? [command.icon.light, command.icon.dark] : [],
    ),
    ...walkthroughs.flatMap((walkthrough: { steps: { media: { image: string } }[] }) =>
      walkthrough.steps.map((step) => step.media.image),
    ),
  ];
  for (const file of files) {
    assert.ok(file.startsWith("media/"), file);
    assert.ok(existsSync(path.join(root, file)), file);
  }
});
