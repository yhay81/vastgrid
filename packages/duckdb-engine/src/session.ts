/**
 * The DuckDB database of an engine: one database file in a folder of its own, which DuckDB may leave only for
 * the allowed folders, and a pool of connections.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DuckDBConnection, DuckDBInstance, type DuckDBPreparedStatement } from "@duckdb/node-api";
import { cancelled, EngineError, errorMessage, isInterrupt } from "./errors.js";

/** Connections that short queries share. */
const POOL_SIZE = 6;
/** Statements that each pooled connection keeps prepared (`Session.prepared`). */
const PREPARED_PER_CONNECTION = 16;

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function defaultMemoryLimit() {
  const fifth = os.totalmem() / 5 / 1024 ** 3;
  return `${Math.max(1, Math.min(4, Math.floor(fifth)))}GB`;
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A shared system temp directory can serve several users. Only reclaim sessions from our own private folder. */
async function defaultTempDirectory() {
  const uid = process.getuid?.();
  const user = uid ?? createHash("sha256").update(os.homedir()).digest("hex").slice(0, 16);
  const directory = path.join(os.tmpdir(), `vastgrid-${user}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0))) {
    throw new Error(`Cannot use ${directory} as a private temporary directory.`);
  }
  return directory;
}

/** Deletes the session folders of engines whose process ended without cleaning up (for example a crash). */
async function removeStaleSessions(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = /^session-(\d+)-/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    await rm(path.join(directory, entry.name), { recursive: true, force: true });
  }
}

/** Limits how many long operations (loading files) run at the same time. */
export class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export interface SessionOptions {
  allowedDirectories: string[];
  tempDirectory?: string;
  memoryLimit?: string;
  maxTempDirectorySize?: string;
  threads?: number;
}

/** A DuckDB database in a session folder, with its connections. */
export class Session {
  private readonly pool: DuckDBConnection[] = [];
  private readonly live = new Set<DuckDBConnection>();
  private connections = 0;
  private readonly waiters: { resolve: (connection: DuckDBConnection) => void; reject: (error: Error) => void }[] = [];
  /** The statements prepared on each pooled connection, by their SQL, the least recently used first. */
  private readonly statements = new WeakMap<DuckDBConnection, Map<string, DuckDBPreparedStatement>>();
  private nextId = 1;
  private disposed = false;
  /** Loading files. */
  readonly loads = new Gate(1);

  private constructor(
    private readonly instance: DuckDBInstance,
    /** The allowed folders, also by their real location, each ending with a separator. */
    readonly directories: string[],
    /** The session's own folder (and its real location), each ending with a separator. */
    private readonly sessionFolders: string[],
    /** The session's own folder: its database, spilled data and converted files. */
    readonly folder: string,
  ) {}

  static async create(options: SessionOptions): Promise<Session> {
    const temp =
      options.tempDirectory === undefined ? await defaultTempDirectory() : path.resolve(options.tempDirectory);
    if (options.tempDirectory !== undefined) await mkdir(temp, { recursive: true });
    await removeStaleSessions(temp);
    const folder = path.join(temp, `session-${process.pid}-${randomBytes(4).toString("hex")}`);
    await mkdir(folder, { recursive: true });
    // Tables live in a database file of the session: DuckDB compresses them there, which takes a fraction of the
    // memory and temporary disk space that tables in memory need once they spill.
    const instance = await DuckDBInstance.create(path.join(folder, "tables.duckdb"), {
      threads: String(options.threads ?? Math.max(1, os.availableParallelism() - 1)),
      memory_limit: options.memoryLimit ?? defaultMemoryLimit(),
      temp_directory: path.join(folder, "spill"),
      max_temp_directory_size: options.maxTempDirectorySize ?? "8GB",
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
    });
    const withSeparator = (directory: string) => (directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`);
    const resolved = options.allowedDirectories.map((directory) => path.resolve(directory));
    // Files are opened by their real location (links followed), so the folders are allowed by theirs too.
    const real = await Promise.all(resolved.map((directory) => realpath(directory).catch(() => directory)));
    const directories = [...new Set([...resolved, ...real])].map(withSeparator);
    const realFolder = await realpath(folder).catch(() => folder);
    const sessionFolders = [...new Set([folder, realFolder])].map(withSeparator);
    const duckDirectories = [...new Set([...directories, ...sessionFolders])];
    const connection = await instance.connect();
    try {
      // Once external access is disabled it cannot be enabled again and the allowed folders cannot change, so
      // generated SQL can never reach other files.
      await connection.run(`SET allowed_directories = [${duckDirectories.map(quoteLiteral).join(", ")}]`);
      await connection.run("SET enable_external_access = false");
      // Text forms are those of UTC (docs/spec.md §2.4).
      await connection.run("SET TimeZone = 'UTC'");
    } finally {
      connection.closeSync();
    }
    return new Session(instance, directories, sessionFolders, folder);
  }

  /** Whether an absolute path is inside one of the allowed folders. */
  allows(file: string): boolean {
    return this.directories.some((directory) => file.startsWith(directory));
  }

  /** A name for an object of the session (a table, a view or a file) that no other has. */
  createName(prefix: string): string {
    return `${prefix}${this.nextId++}_${randomBytes(4).toString("hex")}`;
  }

  /** A path for a file of the session. */
  file(name: string): string {
    return path.join(this.folder, name);
  }

  private clearStatements(connection: DuckDBConnection) {
    for (const statement of this.statements.get(connection)?.values() ?? []) statement.destroySync();
    this.statements.delete(connection);
  }

  private closeConnection(connection: DuckDBConnection) {
    this.clearStatements(connection);
    if (this.live.delete(connection)) connection.closeSync();
  }

  private async acquire(signal?: AbortSignal): Promise<DuckDBConnection> {
    if (this.disposed) throw new EngineError("internal", "The engine was closed.");
    if (signal?.aborted) throw cancelled();
    const free = this.pool.pop();
    if (free) return free;
    if (this.connections < POOL_SIZE) {
      this.connections++;
      try {
        const connection = await this.instance.connect();
        this.live.add(connection);
        if (this.disposed) {
          this.closeConnection(connection);
          this.connections--;
          throw new EngineError("internal", "The engine was closed.");
        }
        await connection.run("SET TimeZone = 'UTC'");
        return connection;
      } catch (error) {
        if (!this.disposed) this.connections--;
        throw error;
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (connection: DuckDBConnection) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(connection);
        },
        reject: (error: Error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(cancelled());
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(connection: DuckDBConnection) {
    if (this.disposed) {
      this.closeConnection(connection);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(connection);
    else this.pool.push(connection);
  }

  /** Runs `task` on a pooled connection, and interrupts its query when `signal` aborts. */
  async withConnection<T>(
    signal: AbortSignal | undefined,
    task: (connection: DuckDBConnection) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw cancelled();
    const connection = await this.acquire(signal);
    if (signal?.aborted) {
      // Cancelled while it waited for a connection: an abort listener added now would never fire.
      this.release(connection);
      throw cancelled();
    }
    const interrupt = () => connection.interrupt();
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
      return await task(connection);
    } catch (error) {
      if (isInterrupt(error)) this.clearStatements(connection);
      if (signal?.aborted && isInterrupt(error)) throw cancelled();
      throw error;
    } finally {
      signal?.removeEventListener("abort", interrupt);
      this.release(connection);
    }
  }

  /**
   * A statement of a pooled connection prepared for `sql`, kept for the next run of the same SQL: DuckDB 2.0 takes
   * longer to parse and plan a query than to run a short read, such as a block of rows, again.
   */
  async prepared(connection: DuckDBConnection, sql: string): Promise<DuckDBPreparedStatement> {
    let statements = this.statements.get(connection);
    if (!statements) {
      statements = new Map();
      this.statements.set(connection, statements);
    }
    let statement = statements.get(sql);
    if (statement) statements.delete(sql);
    else {
      statement = await connection.prepare(sql);
      for (const [oldest, old] of statements) {
        if (statements.size < PREPARED_PER_CONNECTION) break;
        statements.delete(oldest);
        old.destroySync();
      }
    }
    statements.set(sql, statement);
    return statement;
  }

  /** A connection of its own, for loading a file; the caller closes it with `close`. */
  async connect(): Promise<DuckDBConnection> {
    if (this.disposed) throw new EngineError("internal", "The engine was closed.");
    const connection = await this.instance.connect();
    this.live.add(connection);
    if (this.disposed) {
      this.closeConnection(connection);
      throw new EngineError("internal", "The engine was closed.");
    }
    await connection.run("SET TimeZone = 'UTC'");
    return connection;
  }

  /** Closes a dedicated connection opened with `connect`. */
  close(connection: DuckDBConnection): void {
    this.closeConnection(connection);
  }

  /**
   * The text of an error for clients: without the SQL that DuckDB quotes (`LINE 1: …`), and without the session's
   * and the allowed folders in paths, so that answers do not show how the server is laid out.
   */
  clientMessage(error: unknown): string {
    const folders = [...this.sessionFolders, ...this.directories]
      .flatMap((folder) => {
        const bare = folder.endsWith(path.sep) ? folder.slice(0, -path.sep.length) : folder;
        return bare ? [folder, bare] : [folder];
      })
      .filter((folder) => folder !== path.parse(folder).root);
    const unique = [...new Set(folders)].sort((a, b) => b.length - a.length);
    let message = errorMessage(error).replace(/\n\s*LINE \d+:[\s\S]*$/, "");
    for (const folder of unique) message = message.replaceAll(folder, "");
    return message.trim();
  }

  /** Closes the connections and the database, and deletes the session's folder. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new EngineError("internal", "The engine was closed."));
    }
    for (const connection of this.pool.splice(0)) this.closeConnection(connection);
    for (const connection of [...this.live]) this.closeConnection(connection);
    this.instance.closeSync();
    await rm(this.folder, { recursive: true, force: true });
  }
}
