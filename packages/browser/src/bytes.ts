import { abortError, SourceError } from "vastgrid-core";
import { BrowserErrorCodes, errorMessage, isKnownError } from "./errors.js";

/** Bytes read so far: what the source took from the disk or the network. */
export interface Transfer {
  /** Bytes received (from the network, or read from a local file). */
  bytes: number;
  /** Reads (HTTP requests, or reads of the local file). Reads answered from the cache are not counted. */
  requests: number;
}

/** A file that can be read in byte ranges. */
export interface ByteSource {
  readonly size: number;
  /** Changes when the file changes (an `ETag` or `Last-Modified`), when known. */
  readonly revision?: string;
  readonly transfer: Transfer;
  /** Reads bytes `start` (inclusive) to `end` (exclusive). */
  read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
}

function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

/** A local file (`File` or `Blob`). Reads only the slices asked for. */
export class BlobBytes implements ByteSource {
  readonly transfer: Transfer = { bytes: 0, requests: 0 };

  constructor(private readonly blob: Blob) {}

  get size() {
    return this.blob.size;
  }

  async read(start: number, end: number, signal?: AbortSignal) {
    checkSignal(signal);
    const buffer = await this.blob.slice(start, end).arrayBuffer();
    checkSignal(signal);
    this.transfer.bytes += buffer.byteLength;
    this.transfer.requests++;
    return new Uint8Array(buffer);
  }
}

export interface HttpOptions {
  /** Headers for every request, for example `Authorization`. Headers other than `Range` make CORS preflight requests. */
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  /**
   * When the server ignores `Range` requests and sends the whole file, keep it in memory up to this size
   * (default 16 MiB); larger files fail with `range_not_supported`.
   */
  maxDownloadBytes?: number;
  /** Bytes of answered ranges kept for reading again (default 32 MiB). */
  cacheBytes?: number;
  /** A `fetch` to use instead of the global one. Not available through `BrowserSource`, which runs in a worker. */
  fetch?: typeof fetch;
}

const defaultMaxDownload = 16 * 1024 * 1024;
const defaultCacheBytes = 32 * 1024 * 1024;

/** `ETag`, or else `Last-Modified`. Cross-origin servers must list them in `Access-Control-Expose-Headers`. */
function validatorOf(response: Response) {
  return response.headers.get("etag") ?? response.headers.get("last-modified") ?? undefined;
}

function lengthOf(text: string | null) {
  if (text === null || !/^\d+$/.test(text.trim())) return null;
  return Number(text);
}

/** The total size in a `Content-Range: bytes 0-0/1234` header, or null (`*` or missing). */
function totalOf(text: string | null) {
  const match = text ? /\/(\d+)\s*$/.exec(text) : null;
  return match ? Number(match[1]) : null;
}

function httpError(url: string, response: Response) {
  return new SourceError(
    BrowserErrorCodes.httpError,
    `${url} answered ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
    response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 403 : 502,
  );
}

function networkError(url: string, error: unknown) {
  return new SourceError(
    BrowserErrorCodes.networkError,
    `Could not read ${url} (${errorMessage(error)}). A file on another origin must be served with CORS: ` +
      "Access-Control-Allow-Origin, and Access-Control-Expose-Headers listing Content-Length, Content-Range and ETag.",
    502,
  );
}

function fileChanged(url: string) {
  return new SourceError(BrowserErrorCodes.fileChanged, `${url} changed while it was open. Open it again.`, 409);
}

function tooLarge(url: string, limit: number) {
  return new SourceError(
    BrowserErrorCodes.rangeNotSupported,
    `${url} is served without byte ranges (HTTP Range), and it is larger than ${limit} bytes, the most that is downloaded whole.`,
    422,
  );
}

/** Reads a whole body, failing as soon as it grows past `limit`. */
async function readBody(url: string, response: Response, limit: number, signal?: AbortSignal) {
  const declared = lengthOf(response.headers.get("content-length"));
  if (declared !== null && declared > limit) {
    await response.body?.cancel();
    throw tooLarge(url, limit);
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel();
      throw abortError();
    }
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge(url, limit);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/**
 * A file on a web server, read with HTTP `Range` requests. The size comes from a `HEAD` request (or the
 * `Content-Range` of a one-byte range), and every answer is checked against the first `ETag` (or
 * `Last-Modified`) so that a file replaced while it is open fails with `file_changed` rather than mixing
 * two versions. Servers that ignore `Range` work for files up to `maxDownloadBytes`, downloaded once.
 */
export class HttpBytes implements ByteSource {
  readonly transfer: Transfer = { bytes: 0, requests: 0 };
  private readonly cache = new Map<string, Uint8Array>();
  private cached = 0;
  private whole: Uint8Array | null = null;

  private constructor(
    readonly url: string,
    readonly size: number,
    readonly revision: string | undefined,
    private readonly options: HttpOptions,
  ) {}

  /** Finds the size of the file at `url`; reads nothing else. */
  static async open(url: string, options: HttpOptions = {}, signal?: AbortSignal): Promise<HttpBytes> {
    const fetcher = options.fetch ?? fetch;
    const init = { headers: options.headers, credentials: options.credentials, signal };
    let transfer = 0;
    let requests = 0;
    try {
      requests++;
      const head = await fetcher(url, { ...init, method: "HEAD" });
      const size = head.ok ? lengthOf(head.headers.get("content-length")) : null;
      // Content-Length of a compressed answer is not the size of the file.
      if (size !== null && !head.headers.get("content-encoding")) {
        const bytes = new HttpBytes(url, size, validatorOf(head), options);
        bytes.transfer.requests = requests;
        return bytes;
      }
      if (head.status === 401 || head.status === 403 || head.status === 404) throw httpError(url, head);
    } catch (error) {
      if (isKnownError(error)) throw error;
      // Some servers and storage services refuse HEAD; a range request tells the size too.
    }
    let response: Response;
    try {
      requests++;
      response = await fetcher(url, { ...init, headers: { ...options.headers, Range: "bytes=0-0" } });
    } catch (error) {
      if (isKnownError(error)) throw error;
      throw networkError(url, error);
    }
    if (response.status === 206) {
      const size = totalOf(response.headers.get("content-range"));
      const body = new Uint8Array(await response.arrayBuffer());
      transfer += body.byteLength;
      if (size === null) {
        throw new SourceError(
          BrowserErrorCodes.sizeUnknown,
          `The size of ${url} is unknown: the server sent neither Content-Length nor a Content-Range with the size. ` +
            "A server on another origin must list them in Access-Control-Expose-Headers.",
          422,
        );
      }
      const bytes = new HttpBytes(url, size, validatorOf(response), options);
      bytes.transfer.bytes = transfer;
      bytes.transfer.requests = requests;
      return bytes;
    }
    if (!response.ok) throw httpError(url, response);
    // The server ignores Range and sends the whole file.
    const whole = await readBody(url, response, options.maxDownloadBytes ?? defaultMaxDownload, signal);
    const bytes = new HttpBytes(url, whole.byteLength, validatorOf(response), options);
    bytes.whole = whole;
    bytes.transfer.bytes = whole.byteLength;
    bytes.transfer.requests = requests;
    return bytes;
  }

  /**
   * Asks the server (a `HEAD` request) whether the file changed since it was opened: its `ETag` or
   * `Last-Modified`, or else its size, differ, or it is gone (404, 410). Null when the answer does not
   * tell (the server refuses `HEAD`, or sends none of these headers).
   */
  async changed(signal?: AbortSignal): Promise<boolean | null> {
    const fetcher = this.options.fetch ?? fetch;
    let head: Response;
    try {
      head = await fetcher(this.url, {
        method: "HEAD",
        headers: this.options.headers,
        credentials: this.options.credentials,
        signal,
      });
    } catch (error) {
      if (isKnownError(error)) throw error;
      return null;
    }
    if (head.status === 404 || head.status === 410) return true;
    if (!head.ok) return null;
    const validator = validatorOf(head);
    if (validator && this.revision) return validator !== this.revision;
    const size = head.headers.get("content-encoding") ? null : lengthOf(head.headers.get("content-length"));
    return size === null ? null : size !== this.size;
  }

  /** Whether the server ignored `Range` and the whole file was downloaded. */
  get downloaded() {
    return this.whole !== null;
  }

  async read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    checkSignal(signal);
    end = Math.min(end, this.size);
    if (end <= start) return new Uint8Array(0);
    if (this.whole) return this.whole.subarray(start, end);
    const key = `${start}-${end}`;
    const hit = this.cache.get(key);
    if (hit) {
      // Most recently used last.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const fetcher = this.options.fetch ?? fetch;
    let response: Response;
    try {
      this.transfer.requests++;
      response = await fetcher(this.url, {
        headers: { ...this.options.headers, Range: `bytes=${start}-${end - 1}` },
        credentials: this.options.credentials,
        signal,
      });
    } catch (error) {
      if (isKnownError(error)) throw error;
      throw networkError(this.url, error);
    }
    if (response.status === 416) throw fileChanged(this.url);
    if (!response.ok) throw httpError(this.url, response);
    const validator = validatorOf(response);
    if (this.revision && validator && validator !== this.revision) {
      await response.body?.cancel();
      throw fileChanged(this.url);
    }
    if (response.status !== 206) {
      // The server stopped honouring Range (or never did, and answered HEAD with the size).
      const whole = await readBody(this.url, response, this.options.maxDownloadBytes ?? defaultMaxDownload, signal);
      this.transfer.bytes += whole.byteLength;
      if (whole.byteLength !== this.size) throw fileChanged(this.url);
      this.whole = whole;
      this.cache.clear();
      this.cached = 0;
      return whole.subarray(start, end);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.transfer.bytes += bytes.byteLength;
    if (bytes.byteLength !== end - start) throw fileChanged(this.url);
    this.remember(key, bytes);
    return bytes;
  }

  private remember(key: string, bytes: Uint8Array) {
    const budget = this.options.cacheBytes ?? defaultCacheBytes;
    if (bytes.byteLength > budget) return;
    this.cache.set(key, bytes);
    this.cached += bytes.byteLength;
    for (const [oldKey, old] of this.cache) {
      if (this.cached <= budget) break;
      this.cache.delete(oldKey);
      this.cached -= old.byteLength;
    }
  }
}
