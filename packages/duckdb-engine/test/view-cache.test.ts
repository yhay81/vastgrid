import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedTable } from "../src/table.ts";
import { type Build, ViewCache } from "../src/view-cache.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const table = {} as LoadedTable;
const read = async (value: number) => value;

function building() {
  const first = deferred<number>();
  const done = deferred<number>();
  let signal: AbortSignal;
  let disposed = 0;
  let builds = 0;
  return {
    first,
    done,
    get aborted() {
      return signal.aborted;
    },
    get disposed() {
      return disposed;
    },
    get builds() {
      return builds;
    },
    make(s: AbortSignal): Build<number> {
      builds++;
      signal = s;
      s.addEventListener("abort", () => {
        first.reject(new Error("stopped"));
        done.reject(new Error("stopped"));
      });
      return {
        first: first.promise,
        done: done.promise,
        dispose: async () => {
          disposed++;
        },
      };
    },
  };
}

test("cancelling one reader leaves a shared build running for another reader", async () => {
  const cache = new ViewCache<number>(2);
  const build = building();
  const abort = new AbortController();
  const one = cache.use(table, "a", "t1", false, abort.signal, build.make, read);
  const failed = assert.rejects(one, { code: "cancelled" });
  const two = cache.use(table, "a", "t2", false, undefined, build.make, read);
  abort.abort();
  await failed;
  assert.equal(build.aborted, false);
  build.done.resolve(42);
  build.first.resolve(42);
  assert.equal(await two, 42);
  assert.equal(await cache.use(table, "a", "t2", false, undefined, build.make, read), 42);
  assert.equal(build.builds, 1);
  await cache.forget();
  assert.equal(build.disposed, 1);
});

test("the last cancellation stops the build, and the next attempt can rebuild it", async () => {
  const cache = new ViewCache<number>(1);
  const build = building();
  const abort = new AbortController();
  const one = cache.use(table, "a", "t1", false, abort.signal, build.make, read);
  const failed = assert.rejects(one, { code: "cancelled" });
  abort.abort();
  await failed;
  assert.equal(build.aborted, true);
  const retry = building();
  retry.first.resolve(2);
  retry.done.resolve(2);
  assert.equal(await cache.use(table, "a", "t1", false, undefined, retry.make, read), 2);
  await cache.forget();
  assert.equal(build.disposed, 1);
  assert.equal(retry.disposed, 1);
});

test("a new plan stops an abandoned preview, but another handle can keep following it", async () => {
  const cache = new ViewCache<number>(3);
  const old = building();
  old.first.resolve(1);
  await cache.use(table, "a", "t1", true, undefined, old.make, read);
  await cache.use(table, "a", "t2", true, undefined, old.make, read);
  const next = building();
  next.first.resolve(2);
  next.done.resolve(2);
  await cache.use(table, "b", "t1", false, undefined, next.make, read);
  assert.equal(old.aborted, false);
  cache.unfollow("t2");
  assert.equal(old.aborted, true);
  await cache.forget();
  assert.equal(old.disposed, 1);
});

test("eviction waits for readers, bounds idle views, and completion replaces the preview", async () => {
  const cache = new ViewCache<number>(1);
  const old = building();
  old.first.resolve(1);
  assert.equal(await cache.use(table, "a", "t1", true, undefined, old.make, read), 1);
  old.done.resolve(10);
  const held = deferred<number>();
  const reading = cache.use(table, "a", "t1", false, undefined, old.make, () => held.promise);
  const next = building();
  next.first.resolve(2);
  next.done.resolve(2);
  assert.equal(await cache.use(table, "b", "t2", false, undefined, next.make, read), 2);
  assert.equal(old.disposed, 0);
  held.resolve(10);
  await reading;
  await cache.forget();
  assert.equal(old.disposed, 1);
  assert.equal(next.disposed, 1);
});

test("forgetting a revision cancels its build without dropping another table's result", async () => {
  const cache = new ViewCache<number>(3);
  const old = building();
  old.first.resolve(1);
  await cache.use(table, "old", "t1", true, undefined, old.make, read);
  const next = building();
  next.first.resolve(2);
  next.done.resolve(2);
  const other = {} as LoadedTable;
  await cache.use(other, "new", "t2", false, undefined, next.make, read);
  await cache.forget(table);
  assert.equal(old.aborted, true);
  assert.equal(old.disposed, 1);
  assert.equal(next.disposed, 0);
  await cache.forget();
});

test("a cancelled handle does not keep a shared preview alive after the other handle closes", async () => {
  const cache = new ViewCache<number>(2);
  const build = building();
  const abort = new AbortController();
  const one = cache.use(table, "a", "t1", true, abort.signal, build.make, read);
  const failed = assert.rejects(one, { code: "cancelled" });
  const two = cache.use(table, "a", "t2", true, undefined, build.make, read);
  abort.abort();
  await failed;
  assert.equal(build.aborted, false);
  build.first.resolve(1);
  assert.equal(await two, 1);
  cache.unfollow("t2");
  assert.equal(build.aborted, true);
  await cache.forget();
});
