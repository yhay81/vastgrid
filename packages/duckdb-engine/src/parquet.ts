import { type FileHandle, open } from "node:fs/promises";
import { deserializeTCompactProtocol } from "hyparquet/src/thrift.js";

async function readAt(file: FileHandle, start: number, length: number) {
  const bytes = Buffer.allocUnsafe(length);
  for (let offset = 0; offset < length;) {
    const { bytesRead } = await file.read(bytes, offset, length - offset, start + offset);
    if (!bytesRead) throw new Error("The Parquet footer is incomplete.");
    offset += bytesRead;
  }
  return bytes;
}

/** A Thrift binary field: its byte length as an unsigned varint, then its UTF-8 bytes. */
function fieldName(name: string) {
  const utf8 = Buffer.from(name);
  const length: number[] = [];
  let size = utf8.length;
  while (size >= 128) {
    length.push((size % 128) + 128);
    size = Math.floor(size / 128);
  }
  return Buffer.concat([Buffer.from([...length, size]), utf8]);
}

/**
 * DuckDB's COPY assigns case-insensitively unique names. On collisions we write primitive columns as c0, c1, …
 * and replace just the schema and column paths in the footer. Data pages, offsets, types and statistics stay intact.
 */
export async function renameParquetColumns(path: string, names: readonly string[]) {
  const file = await open(path, "r+");
  try {
    const { size } = await file.stat();
    const trailer = await readAt(file, size - 8, 8);
    const length = trailer.readUInt32LE();
    const start = size - 8 - length;
    const footer = await readAt(file, start, length);
    const metadata = deserializeTCompactProtocol({
      view: new DataView(footer.buffer, footer.byteOffset, footer.length),
      offset: 0,
    }) as {
      field_2: { field_4: Uint8Array }[];
      field_4: { field_1: { field_3: { field_3: Uint8Array[] } }[] }[];
    };
    const encoded = names.map(fieldName);
    const pieces: Buffer[] = [];
    let end = 0;
    function rename(bytes: Uint8Array, index: number) {
      // All temporary names (c + the column index) have a one-byte length prefix.
      const offset = bytes.byteOffset - footer.byteOffset;
      pieces.push(footer.subarray(end, offset - 1), encoded[index]);
      end = offset + bytes.byteLength;
    }
    // The first schema element is the root. Both lists follow the exported column order.
    metadata.field_2.slice(1).forEach((element, index) => rename(element.field_4, index));
    for (const group of metadata.field_4) {
      group.field_1.forEach((column, index) => rename(column.field_3.field_3[0], index));
    }
    pieces.push(footer.subarray(end));
    trailer.writeUInt32LE(pieces.reduce((total, piece) => total + piece.length, 0));
    const output = Buffer.concat([...pieces, trailer]);
    for (let offset = 0; offset < output.length;) {
      const { bytesWritten } = await file.write(output, offset, output.length - offset, start + offset);
      offset += bytesWritten;
    }
    await file.truncate(start + output.length);
  } finally {
    await file.close();
  }
}
