/**
 * The server of `vastgrid` (docs/cli.md): the page, the list of the files that it opens, and the DuckDB engine over
 * HTTP (docs/spec.md §8.8), on 127.0.0.1 only. The address that the command prints holds a token, which the page
 * keeps in a cookie: other sites in the browser, other people on the computer and names that point at 127.0.0.1
 * (DNS rebinding) reach nothing.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createHttpHandler, DuckDBEngine, findTableFiles, tableFormatOf } from "vastgrid-duckdb";

export interface ServeOptions {
  /** The files and folders to open: a folder gives its table files, up to two folders deep. */
  paths: string[];
  /** The port on 127.0.0.1; 0, the default, takes a free one. */
  port?: number;
  /** The token of the address: 16 or more letters, digits, `-` and `_`. A random one by default. */
  token?: string;
  /** Lets the page save written cells into the CSV and TSV files they came from (§7.5). Off by default. */
  save?: boolean;
  /** The folder that the page's names of files are relative to: the current one by default. */
  cwd?: string;
  /** Where the engine keeps its database and spilled data, in a folder of its own that it deletes when it stops. */
  tempDirectory?: string;
  /** The page: `dist/app.html` of the package by default. */
  html?: () => Promise<string>;
  /** Receives problems that no request caused. */
  log?: (message: string, error?: unknown) => void;
}

export interface Served {
  /** The address that opens the page, with the token. */
  url: string;
  port: number;
  /** The files that the page lists, by the names that it opens them with. */
  files(): Promise<string[]>;
  /** Stops the server and the engine, which deletes its temporary folder. */
  close(): Promise<void>;
}

/** Files that the list of a folder holds at most. */
const LIST_LIMIT = 1000;

/**
 * The page's script and styles are inside it, and it reaches nothing but this server; it is in no other site's
 * frame.
 */
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
    "font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** The page as the package builds it (`npm run build`), next to `src` and `dist`. */
async function builtHtml() {
  return readFile(new URL("../dist/app.html", import.meta.url), "utf8");
}

function text(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function sameText(a: string | null | undefined, b: string) {
  const given = Buffer.from(a ?? "");
  const expected = Buffer.from(b);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function cookieOf(request: IncomingMessage, name: string) {
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

function isInside(folder: string, file: string) {
  const relative = path.relative(folder, file);
  return relative !== "" && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

/** The files and folders of `paths`, or why one of them cannot be opened. */
async function sortPaths(paths: string[], cwd: string) {
  const files: string[] = [];
  const folders: string[] = [];
  for (const named of paths) {
    const full = path.resolve(cwd, named);
    const found = await stat(full).catch(() => null);
    if (!found) throw new Error(`${named} does not exist.`);
    if (found.isDirectory()) folders.push(full);
    else if (tableFormatOf(full)) files.push(full);
    else throw new Error(`${named} is not a CSV, TSV, Parquet, JSON Lines or Excel file.`);
  }
  return { files: [...new Set(files)], folders: [...new Set(folders)] };
}

/** Starts the engine and the server of the page, which shows the files of `paths`. */
export async function serve(options: ServeOptions): Promise<Served> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const token = options.token ?? randomBytes(24).toString("base64url");
  if (!/^[\w-]{16,}$/.test(token)) throw new Error("The token is 16 or more letters, digits, - and _.");
  const { files, folders } = await sortPaths(options.paths, cwd);
  const nameOf = (file: string) => (isInside(cwd, file) ? path.relative(cwd, file).split(path.sep).join("/") : file);
  // Only the files named, and the table files of the folders named, open; DuckDB reads nothing outside their folders.
  const opens = (file: string) =>
    files.includes(file) || (tableFormatOf(file) !== null && folders.some((folder) => isInside(folder, file)));
  const tempDirectory = options.tempDirectory ?? path.join(os.tmpdir(), "vastgrid-cli");
  mkdirSync(tempDirectory, { recursive: true });
  const engine = await DuckDBEngine.create({
    allowedDirectories: [...new Set([...folders, ...files.map((file) => path.dirname(file))])],
    resolve: (ref) => {
      const file = path.resolve(cwd, ref);
      if (!opens(file)) throw new Error(`vastgrid was not started with ${ref}.`);
      return file;
    },
    tempDirectory,
    saveFiles: options.save ?? false,
    log: options.log,
  });
  const list = async () => {
    const found = await findTableFiles(folders, LIST_LIMIT);
    return [...new Set([...files, ...found])].map(nameOf);
  };
  const html = options.html ?? builtHtml;
  const api = createHttpHandler(engine, { path: "/api" });
  let hosts = new Set<string>();
  let cookie = "";

  const route = async (request: IncomingMessage, response: ServerResponse) => {
    // A name of another site that points at this computer is not this server's.
    if (!hosts.has(String(request.headers.host))) {
      text(response, 403, "vastgrid answers at 127.0.0.1 and localhost only.\n");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/" && url.searchParams.has("token")) {
      if (!sameText(url.searchParams.get("token"), token)) {
        text(response, 401, "This is not the address that vastgrid printed.\n");
        return;
      }
      // The page keeps the token, which leaves the address.
      url.searchParams.delete("token");
      response.writeHead(303, {
        location: `/${url.search}`,
        "set-cookie": `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (!sameText(cookieOf(request, cookie), token)) {
      text(response, 401, "Open the address that vastgrid printed when it started.\n");
      return;
    }
    if (url.pathname === "/" && request.method === "GET") {
      const page = await html().catch(() => null);
      if (page === null) text(response, 500, "The page is not built: run `npm run build`.\n");
      else {
        response.writeHead(200, PAGE_HEADERS);
        response.end(page);
      }
    } else if (url.pathname === "/files" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ files: await list(), save: options.save ?? false }));
    } else if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      await api(request, response);
    } else {
      text(response, 404, "There is nothing at this path.\n");
    }
  };

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      options.log?.("A request failed", error);
      if (response.headersSent) response.destroy();
      else text(response, 500, "The request failed.\n");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
  } catch (error) {
    await engine.dispose();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`Port ${options.port} is in use.`);
    throw error;
  }
  const { port } = server.address() as AddressInfo;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  // Cookies are not kept apart by port: each server of the computer has its own.
  cookie = `vastgrid-${port}`;

  let closed: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    files: list,
    close() {
      closed ??= (async () => {
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        // Streams of events stay open until they are closed.
        server.closeAllConnections();
        await stopped;
        await engine.dispose();
      })();
      return closed;
    },
  };
}
