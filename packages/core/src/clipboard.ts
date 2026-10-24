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

/**
 * Reads tab-separated values as Excel, Numbers and Google Sheets copy them: rows end with a line break
 * (`\r\n`, `\n` or `\r`), and a field that starts with a quote is quoted (it may hold tabs and line breaks,
 * and `""` is a quote). The line break after the last row is not a row. Rows may have different lengths.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  if (text === "") return rows;
  const length = text.length;
  let row: string[] = [];
  let index = 0;
  for (;;) {
    let field: string;
    const quoted = text[index] === '"' ? quotedField(text, index) : null;
    if (quoted) {
      [field, index] = quoted;
    } else {
      // Not quoted (or a quote that is not closed): the text up to the next tab or line break.
      let end = index;
      while (end < length && text[end] !== "\t" && text[end] !== "\n" && text[end] !== "\r") end++;
      field = text.slice(index, end);
      index = end;
    }
    row.push(field);
    const separator = text[index];
    if (separator === "\t") {
      index++;
      continue;
    }
    rows.push(row);
    row = [];
    if (separator === undefined) break;
    index += separator === "\r" && text[index + 1] === "\n" ? 2 : 1;
    // The line break after the last row ends the text.
    if (index >= length) break;
  }
  return rows;
}

/**
 * The value of a quoted field starting at `start` and where it ends, or null when its quote is not closed
 * by a quote followed by a tab, a line break or the end (the field is then read as it is).
 */
function quotedField(text: string, start: number): [string, number] | null {
  let value = "";
  let at = start + 1;
  for (;;) {
    const quote = text.indexOf('"', at);
    if (quote < 0) return null;
    if (text[quote + 1] === '"') {
      value += text.slice(at, quote + 1);
      at = quote + 2;
      continue;
    }
    const next = text[quote + 1];
    if (next !== undefined && next !== "\t" && next !== "\n" && next !== "\r") return null;
    return [value + text.slice(at, quote), quote + 1];
  }
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return entities[name.toLowerCase()] ?? match;
  });
}

/**
 * Reads the first table of an HTML fragment, as spreadsheets and web pages copy tables: one row per
 * `<tr>`, one cell per `<td>` or `<th>`, with `colspan` and `rowspan` filled with empty cells. A cell's
 * text has its tags removed, `<br>` as a line break, entities decoded and runs of spaces collapsed.
 * Returns null when the fragment has no table. It uses no DOM, so it also runs outside browsers.
 */
export function parseHtmlTable(html: string): string[][] | null {
  const start = html.search(/<table[\s>]/i);
  if (start < 0) return null;
  const end = html.search(/<\/table\s*>/i);
  const table = html.slice(start, end > start ? end : undefined);
  const rows: string[][] = [];
  /** Cells covered by a `rowspan` above, by column: how many rows they still cover. */
  const spans: number[] = [];
  for (const rowMatch of table.matchAll(/<tr[\s>][\s\S]*?(?=<tr[\s>]|<\/table|$)/gi)) {
    const row: string[] = [];
    const fill = () => {
      while ((spans[row.length] ?? 0) > 0) {
        spans[row.length]--;
        row.push("");
      }
    };
    for (const cell of rowMatch[0].matchAll(/<(td|th)(\s[^>]*)?>([\s\S]*?)(?=<\/?(?:td|th|tr)[\s>]|$)/gi)) {
      fill();
      const attributes = cell[2] ?? "";
      const text = decodeEntities(
        cell[3]
          .replace(/<(style|script)[\s\S]*?<\/\1\s*>/gi, "")
          .replace(/<br\s*\/?>/gi, "\u0000")
          .replace(/<[^>]*>/g, "")
          .replace(/[ \t\r\n\f]+/g, " "),
      )
        .split("\u0000")
        .map((line) => line.trim())
        .join("\n");
      const colspan = Math.min(1000, Math.max(1, Number(/colspan\s*=\s*["']?(\d+)/i.exec(attributes)?.[1] ?? 1)));
      const rowspan = Math.min(65_536, Math.max(1, Number(/rowspan\s*=\s*["']?(\d+)/i.exec(attributes)?.[1] ?? 1)));
      for (let column = 0; column < colspan; column++) {
        if (rowspan > 1) spans[row.length] = rowspan - 1;
        row.push(column === 0 ? text : "");
      }
    }
    fill();
    rows.push(row);
  }
  return rows;
}
