import { ErrorCodes, SourceError } from "vastgrid-core";

/** Error codes of the browser sources, in addition to the shared `ErrorCodes` of vastgrid-core. */
export const BrowserErrorCodes = {
  /** The server answered a byte range request with the whole file, and the file is larger than `maxDownloadBytes`. */
  rangeNotSupported: "range_not_supported",
  /** The size of the file is unknown: the server sent no `Content-Length` or `Content-Range` the page may read. */
  sizeUnknown: "size_unknown",
  /** The file changed while it was open (another `ETag` or `Last-Modified`, or a shorter file). Open it again. */
  fileChanged: "file_changed",
  /** The request did not reach the server, or CORS kept the page from reading the answer. */
  networkError: "network_error",
  /** The server answered with an error status, for example 401, 403 or 404. */
  httpError: "http_error",
} as const;

export function loadFailed(message: string) {
  return new SourceError(ErrorCodes.loadFailed, message, 422);
}

/** The error to rethrow as it is: an abort, or an error that already has a code. */
export function isKnownError(error: unknown) {
  return error instanceof SourceError || (error instanceof Error && error.name === "AbortError");
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
