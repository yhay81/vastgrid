/**
 * Writes small `.xlsx` workbooks for tests (and large ones for the benchmark) without dependencies.
 * Sheets are given as the XML of their rows, so tests can write exactly the cells Excel would.
 */

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { crc32, createDeflateRaw } from "node:zlib";

export interface FixtureSheet {
  name: string;
  /** `hidden` or `veryHidden`. */
  state?: string;
  /** The XML of the `<row>` elements, in parts. */
  rows: Iterable<string>;
  /** Merged ranges such as `A1:B2`. */
  merges?: string[];
}

export interface FixtureWorkbook {
  sheets: FixtureSheet[];
  sharedStrings?: string[];
  date1904?: boolean;
  /** Custom number formats (ids from 164). */
  numberFormats?: { id: number; code: string }[];
  /** The number format of each cell style (`s` of a cell is an index into this). Style 0 is General. */
  cellStyles?: number[];
  /** Parts written as they are, replacing generated ones. */
  parts?: Record<string, string>;
  /** A chart sheet listed in the workbook, to check that it is skipped. */
  chartSheet?: string;
}

function escapeXml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** A cell element. `t` is the cell type, `s` the style, `v` the saved value, `f` a formula. */
export function cell(
  reference: string,
  options: { t?: string; s?: number; v?: string | number; f?: string; is?: string },
) {
  const attributes = [`r="${reference}"`];
  if (options.s !== undefined) attributes.push(`s="${options.s}"`);
  if (options.t !== undefined) attributes.push(`t="${options.t}"`);
  const inner = [
    options.f === undefined ? "" : `<f>${escapeXml(options.f)}</f>`,
    options.v === undefined ? "" : `<v>${escapeXml(String(options.v))}</v>`,
    options.is === undefined ? "" : `<is><t>${escapeXml(options.is)}</t></is>`,
  ].join("");
  return inner === "" ? `<c ${attributes.join(" ")}/>` : `<c ${attributes.join(" ")}>${inner}</c>`;
}

export function row(number: number, cells: string[]) {
  return `<row r="${number}">${cells.join("")}</row>`;
}

const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function* sheetXml(sheet: FixtureSheet) {
  yield `${xml}<worksheet xmlns="${main}" xmlns:r="${relationships}"><sheetData>`;
  yield* sheet.rows;
  yield "</sheetData>";
  if (sheet.merges?.length) {
    yield `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((range) => `<mergeCell ref="${range}"/>`).join("")}</mergeCells>`;
  }
  yield "</worksheet>";
}

function parts(workbook: FixtureWorkbook): [string, Iterable<string>][] {
  const sheetRelations = workbook.sheets.map(
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="${relationships}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  );
  const extra = workbook.sheets.length;
  const sheetList = workbook.sheets.map(
    (sheet, index) =>
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ""} r:id="rId${index + 1}"/>`,
  );
  if (workbook.chartSheet) {
    sheetRelations.push(
      `<Relationship Id="rId${extra + 3}" Type="${relationships}/chartsheet" Target="chartsheets/sheet1.xml"/>`,
    );
    sheetList.splice(
      1,
      0,
      `<sheet name="${escapeXml(workbook.chartSheet)}" sheetId="${extra + 3}" r:id="rId${extra + 3}"/>`,
    );
  }
  const formats = workbook.numberFormats ?? [];
  const styles = workbook.cellStyles ?? [0];
  const generated: [string, Iterable<string>][] = [
    [
      "[Content_Types].xml",
      [
        `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
      ],
    ],
    [
      "_rels/.rels",
      [
        `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ],
    ],
    [
      "xl/workbook.xml",
      [
        `${xml}<workbook xmlns="${main}" xmlns:r="${relationships}"><workbookPr${workbook.date1904 ? ' date1904="1"' : ""}/><sheets>${sheetList.join("")}</sheets></workbook>`,
      ],
    ],
    [
      "xl/_rels/workbook.xml.rels",
      [
        `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRelations.join("")}<Relationship Id="rId${extra + 1}" Type="${relationships}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId${extra + 2}" Type="${relationships}/styles" Target="styles.xml"/></Relationships>`,
      ],
    ],
    [
      "xl/styles.xml",
      [
        `${xml}<styleSheet xmlns="${main}"><numFmts count="${formats.length}">${formats.map((format) => `<numFmt numFmtId="${format.id}" formatCode="${escapeXml(format.code)}"/>`).join("")}</numFmts><cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs><cellXfs count="${styles.length}">${styles.map((id) => `<xf numFmtId="${id}" xfId="0"/>`).join("")}</cellXfs></styleSheet>`,
      ],
    ],
    [
      "xl/sharedStrings.xml",
      [
        `${xml}<sst xmlns="${main}">${(workbook.sharedStrings ?? []).map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join("")}</sst>`,
      ],
    ],
    ...workbook.sheets.map(
      (sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet)] as [string, Iterable<string>],
    ),
  ];
  const replaced = workbook.parts ?? {};
  return [
    ...generated.filter(([name]) => !(name in replaced)),
    ...Object.entries(replaced).map(([name, text]) => [name, [text]] as [string, Iterable<string>]),
  ];
}

/** Writes the workbook as a ZIP archive of deflated entries, each followed by its sizes (written as it streams). */
export async function writeWorkbook(file: string, workbook: FixtureWorkbook) {
  const output = createWriteStream(file);
  let offset = 0;
  const write = async (data: Buffer) => {
    offset += data.length;
    if (!output.write(data)) await once(output, "drain");
  };
  const central: Buffer[] = [];
  for (const [name, chunks] of parts(workbook)) {
    const nameBytes = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6); // sizes follow the data; names are UTF-8
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(nameBytes.length, 26);
    const start = offset;
    await write(Buffer.concat([header, nameBytes]));
    let crc = 0;
    let size = 0;
    let compressed = 0;
    const deflate = createDeflateRaw({ level: 1 });
    const pumped = (async () => {
      for await (const data of deflate) {
        compressed += (data as Buffer).length;
        await write(data as Buffer);
      }
    })();
    for (const chunk of chunks) {
      const data = Buffer.from(chunk, "utf8");
      crc = crc32(data, crc);
      size += data.length;
      if (!deflate.write(data)) await once(deflate, "drain");
    }
    deflate.end();
    await pumped;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await write(descriptor);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0808, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc >>> 0, 16);
    entry.writeUInt32LE(compressed, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(start, 42);
    central.push(entry, nameBytes);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(directory);
  await write(end);
  output.end();
  await once(output, "finish");
}
