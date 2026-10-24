import { use, useEffect, useState, useSyncExternalStore } from "react";
import type { JsonValue } from "vastgrid-spec";
import { createGridStore, type GridStore, type GridStoreOptions } from "../core/store.js";
import type { GridSnapshot } from "../core/types.js";
import { GridContext } from "./context.js";

/** The store of the nearest `DataGrid` or `GridProvider`. */
export function useGridStore(): GridStore {
  const store = use(GridContext);
  if (!store) throw new Error("useGridStore needs a DataGrid or a GridProvider around it.");
  return store;
}

/** Whether two values are the same, or objects or arrays whose members are the same (`Object.is`). */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) && Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** The last value a selector gave, kept while the snapshot stays or the next value is equal. */
class Selection<T> {
  private snapshot: GridSnapshot | undefined;
  private selector: ((snapshot: GridSnapshot) => T) | undefined;
  private value: T | undefined;

  read(snapshot: GridSnapshot, selector: (snapshot: GridSnapshot) => T, isEqual: (a: T, b: T) => boolean): T {
    if (snapshot === this.snapshot && selector === this.selector) return this.value as T;
    const next = selector(snapshot);
    if (this.snapshot === undefined || !isEqual(this.value as T, next)) this.value = next;
    this.snapshot = snapshot;
    this.selector = selector;
    return this.value as T;
  }
}

/**
 * A part of the store's snapshot (§5.3 of v2-react.md). The component renders again only when the selected value
 * changes by `isEqual` (`Object.is` by default). Selectors run on every change of the store: they are cheap and
 * make no new objects unless `isEqual` compares them (`shallowEqual`).
 */
export function useGridSelector<T>(
  selector: (snapshot: GridSnapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useGridStore();
  const [selection] = useState(() => new Selection<T>());
  const read = () => selection.read(store.getSnapshot(), selector, isEqual);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The store's `dispatch`: the same function on every render. */
export function useGridDispatch(): GridStore["dispatch"] {
  return useGridStore().dispatch;
}

/** A store for the life of the component: made once from the first options, connected while it is mounted. */
export function useCreateGridStore(options: GridStoreOptions): GridStore {
  const [store] = useState(() => createGridStore(options));
  useEffect(() => store.connect(), [store]);
  return store;
}

/**
 * Values of rows `[start, end)` of the view on screen, for cells that React renders (a detail panel, an overlay):
 * one array per row, with undefined for values not read yet. Reads them when they are missing, and renders again
 * when rows arrive.
 */
export function useGridRows(range: {
  start: number;
  end: number;
  columns: readonly string[];
}): (JsonValue | undefined)[][] {
  const store = useGridStore();
  const version = useSyncExternalStore(store.subscribeRows, store.getRowsVersion, store.getRowsVersion);
  const { start, end, columns } = range;
  const names = columns.join("\u0000");
  useEffect(() => {
    store.ensure(start, end, names === "" ? [] : names.split("\u0000"));
  }, [store, start, end, names]);
  return readRows(store, version, start, end, columns);
}

/**
 * Reads rows of the store's cache. The cache changes inside the store, so the version of its rows is an argument:
 * memoization (React Compiler's included) reads them again when it changes.
 */
export function readRows(
  store: GridStore,
  _version: number,
  start: number,
  end: number,
  columns: readonly string[],
): (JsonValue | undefined)[][] {
  const rows: (JsonValue | undefined)[][] = [];
  for (let row = start; row < end; row++) rows.push(columns.map((column) => store.cell(row, column)));
  return rows;
}
