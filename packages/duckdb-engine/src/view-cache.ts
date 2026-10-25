/** Shared, cancellable view builds and their bounded, least-recently-used storage. */
import { cancelled } from "./errors.js";
import type { LoadedTable } from "./table.js";

export interface Build<T> {
  first: Promise<T>;
  done: Promise<T>;
  dispose: () => Promise<void>;
}

interface Entry<T> extends Build<T> {
  table: LoadedTable;
  controller: AbortController;
  users: number;
  readers: Map<string, number>;
  followers: Set<string>;
  finished: boolean;
  removed: boolean;
  drained?: () => void;
}

/** A request can stop waiting without cancelling other requests for the same result. */
export function untilCancelled<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}

export class ViewCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly following = new Map<string, Entry<T>>();
  private readonly dropping = new Set<Promise<void>>();

  constructor(private readonly limit: number) {}

  async use<R>(
    table: LoadedTable,
    key: string,
    handle: string,
    preview: boolean,
    signal: AbortSignal | undefined,
    make: (signal: AbortSignal) => Build<T>,
    read: (view: T) => Promise<R>,
  ): Promise<R> {
    if (signal?.aborted) throw cancelled();
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = {
        ...make(controller.signal),
        table,
        controller,
        users: 0,
        readers: new Map(),
        followers: new Set(),
        finished: false,
        removed: false,
      };
      this.entries.set(key, entry);
      const created = entry;
      void created.done.then(
        () => {
          created.finished = true;
          this.trim();
        },
        () => this.remove(created),
      );
      // A non-preview caller may be the only caller of the build.
      void created.first.catch(() => {});
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.users++;
    entry.readers.set(handle, (entry.readers.get(handle) ?? 0) + 1);
    const previous = this.following.get(handle);
    if (previous !== entry) {
      this.unfollow(handle);
      this.following.set(handle, entry);
      entry.followers.add(handle);
    }
    this.trim();
    try {
      const view = await untilCancelled(preview && !entry.finished ? entry.first : entry.done, signal);
      if (entry.removed || signal?.aborted) throw cancelled();
      return await read(view);
    } finally {
      entry.users--;
      if (entry.users === 0) entry.drained?.();
      const readers = (entry.readers.get(handle) as number) - 1;
      if (readers > 0) entry.readers.set(handle, readers);
      else entry.readers.delete(handle);
      if (signal?.aborted && readers === 0 && this.following.get(handle) === entry) this.unfollow(handle);
      this.abandon(entry);
      this.trim();
    }
  }

  unfollow(handle: string) {
    const previous = this.following.get(handle);
    this.following.delete(handle);
    if (previous) {
      previous.followers.delete(handle);
      this.abandon(previous);
    }
  }

  private abandon(entry: Entry<T>) {
    if (!entry.finished && entry.users === 0 && entry.followers.size === 0) this.remove(entry);
  }

  private trim() {
    for (const entry of this.entries.values()) {
      if (this.entries.size <= this.limit) break;
      if (entry.users === 0 && entry.finished) this.remove(entry);
    }
  }

  private remove(entry: Entry<T>) {
    if (entry.removed) return;
    entry.removed = true;
    entry.controller.abort();
    for (const [key, value] of this.entries) if (value === entry) this.entries.delete(key);
    for (const handle of entry.followers) if (this.following.get(handle) === entry) this.following.delete(handle);
    // Reads already using the table must finish before its storage is dropped.
    const cleanup = (async () => {
      await entry.done.catch(() => {});
      if (entry.users > 0)
        await new Promise<void>((resolve) => {
          entry.drained = resolve;
        });
      await entry.dispose();
    })();
    this.dropping.add(cleanup);
    void cleanup.finally(() => this.dropping.delete(cleanup)).catch(() => {});
  }

  async forget(table?: LoadedTable) {
    for (const entry of this.entries.values()) if (!table || entry.table === table) this.remove(entry);
    await Promise.all(this.dropping);
  }
}
