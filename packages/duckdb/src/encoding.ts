import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Text encodings of delimited files. DuckDB reads UTF-8 (with or without BOM), UTF-16 and Latin-1
 * itself; Japanese encodings common in spreadsheets exported on Windows (Shift_JIS, EUC-JP) are
 * converted to UTF-8 first.
 */
export type TextEncoding = "utf-8" | "utf-16" | "shift_jis" | "euc-jp" | "latin-1";

const SAMPLE_BYTES = 4 * 1024 * 1024;

function decodes(bytes: Uint8Array, encoding: string, partial: boolean) {
  try {
    new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: partial });
    return true;
  } catch {
    return false;
  }
}

/** Japanese text: kana, or CJK ideographs. */
function looksJapanese(text: string) {
  return /[ぁ-ヿ一-鿿]/.test(text);
}

/** Detects the encoding from the first megabytes of a file. Compressed files are left to DuckDB. */
export async function detectEncoding(path: string): Promise<TextEncoding> {
  if (/\.(gz|zst)$/i.test(path)) return "utf-8";
  const handle = await open(path, "r");
  let bytes: Uint8Array;
  let partial: boolean;
  try {
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, 0);
    bytes = buffer.subarray(0, bytesRead);
    partial = bytesRead === SAMPLE_BYTES;
  } finally {
    await handle.close();
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return "utf-16";
  if (decodes(bytes, "utf-8", partial)) return "utf-8";
  for (const encoding of ["shift_jis", "euc-jp"] as const) {
    if (!decodes(bytes, encoding, partial)) continue;
    const text = new TextDecoder(encoding).decode(bytes.subarray(0, 256 * 1024));
    if (looksJapanese(text)) return encoding;
  }
  return "latin-1";
}

/**
 * Converts a file to UTF-8 (invalid bytes become U+FFFD). Used for encodings DuckDB cannot read and
 * for files whose UTF-8 breaks beyond the sample.
 */
export async function convertToUtf8(source: string, target: string, encoding: string, signal?: AbortSignal) {
  const decoder = new TextDecoder(encoding === "latin-1" ? "windows-1252" : encoding);
  const encoder = new TextEncoder();
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, encoder.encode(decoder.decode(chunk, { stream: true })));
    },
    flush(callback) {
      callback(null, encoder.encode(decoder.decode()));
    },
  });
  await pipeline(createReadStream(source, { highWaterMark: 1024 * 1024 }), transform, createWriteStream(target), {
    signal,
  });
}
