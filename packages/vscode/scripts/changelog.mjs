// The extension's CHANGELOG.md, which the Marketplace and Open VSX show in a tab of their own: the versions of the
// repository's CHANGELOG.md with only the items about `vastgrid-vscode` (the ones whose packages, before the first
// ": ", name it), without that name when it is the only one, and with links into the repository made absolute.

const REPOSITORY = "https://github.com/yhay81/vastgrid/blob/main/";

/** The extension's changelog, from the text of the repository's. */
export function extensionChangelog(text) {
  const versions = [];
  let item = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      versions.push({ heading: line, sections: [] });
      item = null;
    } else if (line.startsWith("### ") && versions.length > 0) {
      versions.at(-1).sections.push({ heading: line, items: [] });
      item = null;
    } else if (line.startsWith("- ") && versions.at(-1)?.sections.length > 0) {
      item = [line];
      versions.at(-1).sections.at(-1).items.push(item);
    } else if (line.startsWith("  ") && item) {
      item.push(line);
    } else {
      item = null;
    }
  }

  const out = [
    "# Changelog",
    "",
    `The changes to the extension, from the repository's [CHANGELOG.md](${REPOSITORY}CHANGELOG.md).`,
  ];
  for (const version of versions) {
    const sections = version.sections
      .map((section) => ({ ...section, items: section.items.map(aboutExtension).filter((lines) => lines) }))
      .filter((section) => section.items.length > 0);
    if (sections.length === 0) continue;
    out.push("", version.heading);
    for (const section of sections) {
      out.push("", section.heading, "");
      for (const lines of section.items) out.push(...lines);
    }
  }
  return `${out.join("\n")}\n`;
}

/** The item's lines for the extension's changelog, or null when the item is not about the extension. */
function aboutExtension(lines) {
  const text = lines.join("\n");
  const colon = text.indexOf(": ");
  if (colon < 0) return null;
  const packages = text.slice(2, colon);
  if (!packages.includes("`vastgrid-vscode`")) return null;
  const own = packages === "`vastgrid-vscode`" ? `- ${capitalize(text.slice(colon + 2))}` : text;
  return own.replace(/\]\((?![a-z]+:|#)([^)]+)\)/g, (_, link) => `](${REPOSITORY}${link})`).split("\n");
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
