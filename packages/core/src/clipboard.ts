/** Text and HTML that Excel, Numbers and Google Sheets paste as cells. */

function tsvField(text: string) {
  return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Tab-separated values. Fields with tabs, line breaks or quotes are quoted like Excel does. */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(tsvField).join("\t")).join("\n");
}

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** An HTML table. The first `headerRows` rows become `<th>` cells. */
export function toHtmlTable(rows: readonly (readonly string[])[], headerRows = 0): string {
  const body = rows
    .map((row, index) => {
      const tag = index < headerRows ? "th" : "td";
      const cells = row.map((cell) => `<${tag}>${escapeHtml(cell).replace(/\r\n|\n|\r/g, "<br>")}</${tag}>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<meta charset="utf-8"><table>${body}</table>`;
}

/** A Markdown table, for pasting into issues and documents. */
export function toMarkdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r\n|\n|\r/g, "<br>");
  const lines = [
    `| ${header.map(cell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
  return lines.join("\n");
}
