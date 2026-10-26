/**
 * Watching the files of open tables (docs/v2-spec.md §7.6). The folders are watched, not the files: editors, and
 * the engine's own saves, replace a file by renaming another over it, which a watch of the file would not follow.
 */
import { type FSWatcher, watch } from "node:fs";
import path from "node:path";

interface Folder {
  watcher: FSWatcher;
  /** The callbacks of each watched file, by its name in the folder. */
  files: Map<string, Set<() => void>>;
}

/** Calls back once a file has stopped changing for a moment. */
export class FileWatcher {
  private readonly folders = new Map<string, Folder>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    /** How long a file must stay unchanged, in milliseconds, so that a burst of changes calls back once. */
    private readonly delay: number,
    private readonly log?: (message: string, error?: unknown) => void,
  ) {}

  /** Calls `changed` after the file changes, until the function that it gives is called. */
  watch(file: string, changed: () => void): () => void {
    const name = path.basename(file);
    const folder = this.folder(path.dirname(file));
    if (!folder) return () => undefined;
    const callbacks = folder.files.get(name) ?? new Set<() => void>();
    callbacks.add(changed);
    folder.files.set(name, callbacks);
    return () => {
      callbacks.delete(changed);
      if (callbacks.size === 0 && folder.files.get(name) === callbacks) folder.files.delete(name);
      if (folder.files.size === 0 && this.folders.get(path.dirname(file)) === folder) this.close(path.dirname(file));
    };
  }

  private folder(directory: string): Folder | null {
    const known = this.folders.get(directory);
    if (known) return known;
    let watcher: FSWatcher;
    try {
      watcher = watch(directory, { persistent: false }, (_event, name) => this.noticed(directory, name));
    } catch (error) {
      this.log?.(`Could not watch ${directory}`, error);
      return null;
    }
    watcher.on("error", (error) => {
      this.log?.(`Stopped watching ${directory}`, error);
      this.close(directory);
    });
    const folder: Folder = { watcher, files: new Map() };
    this.folders.set(directory, folder);
    return folder;
  }

  private noticed(directory: string, name: string | Buffer | null) {
    const folder = this.folders.get(directory);
    if (!folder) return;
    // Without a name (some platforms give none), any watched file of the folder may have changed.
    const names = name === null ? [...folder.files.keys()] : [String(name)];
    for (const file of names) {
      if (!folder.files.has(file)) continue;
      const key = path.join(directory, file);
      clearTimeout(this.timers.get(key));
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          for (const callback of [...(this.folders.get(directory)?.files.get(file) ?? [])]) callback();
        }, this.delay),
      );
    }
  }

  private close(directory: string) {
    this.folders.get(directory)?.watcher.close();
    this.folders.delete(directory);
    for (const [key, timer] of this.timers) {
      if (path.dirname(key) !== directory) continue;
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  /** Stops watching every folder. */
  dispose(): void {
    for (const directory of [...this.folders.keys()]) this.close(directory);
  }
}
