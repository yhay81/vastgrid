import assert from "node:assert/strict";
import { link, lstat, open, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, vi } from "vite-plus/test";
import { setUp, writeParquet } from "./client.ts";

// Force link failures independently of the OS and which volumes a test runner mounts.
vi.mock(import("node:fs/promises"), async (original) => {
  const fs = await original();
  return { ...fs, link: vi.fn(fs.link), open: vi.fn(fs.open) };
});

const crossDevice = Object.assign(new Error("The session is on another filesystem"), { code: "EXDEV" });

test.each(["EXDEV", "EPERM"])(
  "Parquet copies the verified file after %s even when the source path changes",
  async (code) => {
    const local = await setUp({ allowFile: (file) => path.basename(file) === "visible.parquet" });
    try {
      const visible = path.join(local.workspace, "visible.parquet");
      const hidden = path.join(local.workspace, "hidden.parquet");
      const columns = [{ name: "value", type: "integer" as const }];
      await writeParquet(visible, { columns, rows: [[10]] });
      await writeParquet(hidden, { columns, rows: [[99]] });
      vi.mocked(link).mockImplementationOnce(async () => {
        await rename(visible, path.join(local.workspace, "original.parquet"));
        await symlink(hidden, visible);
        throw Object.assign(new Error("Cannot create a hard link"), { code });
      });
      const opened = await local.client.open("visible.parquet");
      assert.equal(opened.status, "ready");
      assert.deepEqual((await local.client.rows(opened)).rows, [[10]]);
      assert.equal((await local.client.error("open", { ref: "visible.parquet" })).code, "not_allowed");
      const sourceHandles = await Promise.all(vi.mocked(open).mock.results.map((result) => result.value));
      assert.ok(sourceHandles.length > 0 && sourceHandles.every((handle) => handle.fd === -1));
    } finally {
      vi.clearAllMocks();
      await local.tearDown();
    }
  },
);

test("a different inode linked during Parquet open is refused before DuckDB reads it", async () => {
  const local = await setUp({ allowFile: (file) => path.basename(file) === "visible.parquet" });
  try {
    const visible = path.join(local.workspace, "visible.parquet");
    const hidden = path.join(local.workspace, "hidden.parquet");
    const columns = [{ name: "value", type: "integer" as const }];
    await writeParquet(visible, { columns, rows: [[10]] });
    await writeParquet(hidden, { columns, rows: [[99]] });
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(link).mockImplementationOnce(async (_, target) => {
      // Directly link the replacement so the race does not depend on replacing an open file on Windows.
      await fs.link(hidden, target);
    });
    const info = await local.client.open("visible.parquet");
    assert.equal(info.status, "error");
    assert.match(info.error ?? "", /changed/);
    const error = await local.client.error("rows", {
      table: info.table,
      revision: info.revision,
      plan: {},
      columns: ["value"],
      start: 0,
      end: 1,
    });
    assert.equal(error.code, "load_failed");
  } finally {
    vi.clearAllMocks();
    await local.tearDown();
  }
});

test("disposing during a cross-volume Parquet copy closes the file and removes the partial copy", async () => {
  const local = await setUp();
  try {
    const source = path.join(local.workspace, "large.parquet");
    const size = 512 * 1024 * 1024;
    await writeFile(source, "");
    await truncate(source, size);
    let started!: (target: string) => void;
    const copying = new Promise<string>((resolve) => {
      started = resolve;
    });
    vi.mocked(link).mockImplementationOnce(async (_, target) => {
      started(String(target));
      throw crossDevice;
    });
    const opening = local.client.send("open", { ref: "large.parquet" });
    const target = await copying;
    // Wait for the first chunk, before disposing; no timing assumption about how soon the copy starts.
    let copied = 0;
    while (copied === 0) {
      await setImmediate();
      copied = (await lstat(target).catch(() => null))?.size ?? 0;
    }
    assert.ok(copied < size);
    await local.engine.dispose();
    await opening;
    assert.deepEqual(await readdir(path.join(local.root, "temp")), []);
    const handles = await Promise.all(vi.mocked(open).mock.results.map((result) => result.value));
    assert.ok(handles.length > 0 && handles.every((handle) => handle.fd === -1));
    await rm(source);
  } finally {
    vi.clearAllMocks();
    await local.tearDown();
  }
});
