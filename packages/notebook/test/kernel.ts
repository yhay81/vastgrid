/**
 * The notebook's engine, the Python package in `python/`, in a Python process of its own (`uv run`) for the tests:
 * it reads and writes one message per line, bytes as `{ "base64" }` (`python/tests/stdio_server.py`). Without uv,
 * the tests that use it are skipped.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { checkResponse, type Operation } from "vastgrid-spec";

export type Json = Record<string, unknown>;

const folder = fileURLToPath(new URL("../python/", import.meta.url));

/** Why the tests of the engine are skipped, or false when they run. */
export const skip = spawnSync("uv", ["--version"]).status === 0 ? false : "uv is not installed";

/** Bytes that the engine wrote as `{ "base64" }`, as the client reads them. */
function decoded(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decoded);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0][0] === "base64") {
      return { bytes: new Uint8Array(Buffer.from(entries[0][1] as string, "base64")) };
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, decoded(item)]));
  }
  return value;
}

/** The engine in a Python process, which answers each line in turn. */
export class Kernel {
  private readonly child: ChildProcess;
  private readonly waiting: { resolve(value: Json): void; reject(error: Error): void }[] = [];
  private failure: Error | undefined;
  private id = 0;

  constructor(command = "uv", args = ["run", "--quiet", "--frozen", "python", "tests/stdio_server.py"]) {
    this.child = spawn(command, args, {
      cwd: folder,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin?.on("error", (error) => this.fail(error));
    this.child.on("close", (code, signal) => {
      this.fail(new Error(`The notebook test kernel closed (code ${code}, signal ${signal}).`));
    });
    const lines = createInterface({ input: this.child.stdout as NodeJS.ReadableStream });
    lines.on("line", (line) => this.waiting.shift()?.resolve(decoded(JSON.parse(line)) as Json));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.waiting.splice(0)) pending.reject(this.failure);
  }

  line(message: Json): Promise<Json> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.child.stdin?.write(`${JSON.stringify(message)}\n`);
    });
  }

  /** Adds tables, each the bytes of a block (§8.4), to open by their refs. */
  async add(tables: Record<string, Uint8Array>): Promise<void> {
    const added = await this.line({
      tables: Object.fromEntries(
        Object.entries(tables).map(([ref, bytes]) => [ref, { arrow: Buffer.from(bytes).toString("base64") }]),
      ),
    });
    assert.deepEqual(added.errors, {}, "the tables are added");
  }

  /** Sends a request, checking its response against §8. */
  async send(op: Operation, members: Json): Promise<Json> {
    const id = ++this.id;
    const response = await this.line({ v: 2, id, op, ...members });
    checkResponse(response, op);
    assert.equal(response.id, id);
    return response;
  }

  close() {
    this.child.stdin?.end();
  }
}
