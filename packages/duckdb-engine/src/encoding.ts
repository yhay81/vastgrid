import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline as pipe, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { Decompress } from "fzstd";

/**
 * Text encodings of delimited files. Non-UTF-8 files, including both UTF-16 byte orders and Japanese
 * encodings common in spreadsheets exported on Windows (Shift_JIS, EUC-JP), are converted first.
 */
export type TextEncoding = "utf-8" | "utf-16" | "utf-16le" | "utf-16be" | "shift_jis" | "euc-jp" | "latin-1";

const SAMPLE_BYTES = 4 * 1024 * 1024;

/** Zstandard on Node 20, which has no native decoder. */
function zstdDecoder(): Transform {
  if (typeof zlib.createZstdDecompress === "function") return zlib.createZstdDecompress();
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        decoder.push(chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        decoder.push(new Uint8Array(0), true);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  const decoder = new Decompress((chunk) => stream.push(chunk));
  return stream;
}

/** Bytes of the text, after decompression. Closing an early sample also closes the file and decoder. */
async function* textBytes(file: string): AsyncGenerator<Buffer> {
  const input = createReadStream(file, { highWaterMark: 64 * 1024 });
  const decompress = /\.gz$/i.test(file) ? zlib.createGunzip() : /\.zst$/i.test(file) ? zstdDecoder() : null;
  const output = decompress ? pipe(input, decompress, () => undefined) : input;
  try {
    for await (const chunk of output) yield chunk as Buffer;
  } finally {
    input.destroy();
    decompress?.destroy();
  }
}

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

/** Detects the encoding from the first megabytes of text, including compressed files. */
export async function detectEncoding(path: string): Promise<TextEncoding> {
  let bytes: Uint8Array;
  let partial: boolean;
  if (/\.(gz|zst)$/i.test(path)) {
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    let length = 0;
    for await (const chunk of textBytes(path)) {
      const count = Math.min(chunk.length, SAMPLE_BYTES - length);
      buffer.set(chunk.subarray(0, count), length);
      length += count;
      if (length === SAMPLE_BYTES) break;
    }
    bytes = buffer.subarray(0, length);
    partial = length === SAMPLE_BYTES;
  } else {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(SAMPLE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, 0);
      bytes = buffer.subarray(0, bytesRead);
      partial = bytesRead === SAMPLE_BYTES;
    } finally {
      await handle.close();
    }
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
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
  await pipeline(textBytes(source), transform, createWriteStream(target), {
    signal,
  });
}
