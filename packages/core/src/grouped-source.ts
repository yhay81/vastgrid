import { ArraySource } from "./array-source.js";
import { ErrorCodes } from "./protocol.js";
import { isEmptyQuery, SourceError, type TableChangeListener, type TableSource } from "./source.js";
import type {
  AggregateRequest,
  ColumnStats,
  DistinctRequest,
  DistinctValues,
  ExportRequest,
  ExportResult,
  FindRequest,
  FindResult,
  GroupRequest,
  GroupResult,
  RowBlock,
  RowRequest,
  SelectionSummary,
  SortKey,
  TableInfo,
  ViewInfo,
  ViewQuery,
} from "./types.js";

/** What a `GroupedSource` shows: the rows of `query` of the base table, grouped. */
export interface GroupedSourceOptions extends Omit<GroupRequest, "view" | "sort"> {
  /** The rows to group: filters, condition tree and search (the sort does not matter). */
  query?: ViewQuery;
}

interface Shown {
  result: GroupResult;
  table: ArraySource;
}

/**
 * The groups of another source as a table of their own, to show in a grid: one row per group, with
 * the keys and the aggregates as columns (see `GroupResult`). The base source computes the groups
 * (`TableSource.group`), so only the groups reach the grid.
 *
 * Filters, search, statistics, value lists, exports and totals run on the groups that were returned,
 * and are offered only when they are all the groups (the result is not `truncated`). Sorting a
 * truncated result asks the base source again, so that the first `limit` groups are those of the new
 * order; find and the selection summary work on the returned groups. A change
 * of the base table (`subscribe`) groups its rows again.
 */
export class GroupedSource implements TableSource {
  readonly base: TableSource;
  readonly options: GroupedSourceOptions;
  private shown: Shown | null = null;
  private loading: Promise<Shown> | null = null;
  private readonly sorted = new Map<string, Promise<Shown>>();
  private readonly views = new Map<string, { table: ArraySource; view: string | null }>();
  private nextView = 1;
  private revision = 0;

  constructor(base: TableSource, options: GroupedSourceOptions) {
    this.base = base;
    this.options = options;
  }

  /** The groups in their first order, once they are read. */
  get result(): GroupResult | null {
    return this.shown?.result ?? null;
  }

  private async fetch(sort: SortKey[] | undefined, signal?: AbortSignal): Promise<Shown> {
    const group = this.base.group?.bind(this.base);
    if (!group) throw new SourceError(ErrorCodes.invalidRequest, "This table cannot group its rows.", 400);
    const { query = {}, ...request } = this.options;
    const rows: ViewQuery = {
      ...(query.filters?.length ? { filters: query.filters } : {}),
      ...(query.where ? { where: query.where } : {}),
      ...(query.search ? { search: query.search } : {}),
    };
    const view = isEmptyQuery(rows) ? null : (await this.base.createView(rows, signal)).id;
    const result = await group({ ...request, view, ...(sort?.length ? { sort } : {}) }, signal);
    return { result, table: new ArraySource({ columns: result.columns, rows: result.rows }) };
  }

  /**
   * Reads the groups (once; concurrent callers share the request). Rejects with the base source's
   * error, for example `too_many_columns`, so that an app can refuse settings before showing them.
   */
  load(signal?: AbortSignal): Promise<GroupResult> {
    if (this.shown) return Promise.resolve(this.shown.result);
    if (!this.loading) {
      const loading = this.fetch(undefined, signal);
      this.loading = loading;
      loading.then(
        (shown) => {
          if (this.loading === loading) this.shown = shown;
        },
        () => {
          if (this.loading === loading) this.loading = null;
        },
      );
    }
    return this.loading.then((shown) => shown.result);
  }

  async info(signal?: AbortSignal): Promise<TableInfo> {
    const base = await this.base.info(signal);
    if (base.status !== "ready") {
      return {
        columns: [],
        rowCount: null,
        readableRows: 0,
        status: base.status,
        ...(base.error ? { error: base.error } : {}),
        capabilities: capabilitiesOf(false),
      };
    }
    let result: GroupResult;
    try {
      result = await this.load(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        columns: [],
        rowCount: null,
        readableRows: 0,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        capabilities: capabilitiesOf(false),
      };
    }
    const local = (await (this.shown as Shown).table.info()).exports;
    return {
      columns: result.columns,
      rowCount: result.rows.length,
      readableRows: result.rows.length,
      status: "ready",
      format: "group",
      revision: String(this.revision),
      capabilities: capabilitiesOf(true, !result.truncated),
      ...(local && !result.truncated ? { exports: local } : {}),
    };
  }

  private current(): Shown {
    if (!this.shown) throw new SourceError(ErrorCodes.notReady, "The groups are still being read.", 409);
    return this.shown;
  }

  private entry(view: string | null) {
    if (view === null) return { table: this.current().table, view: null };
    const found = this.views.get(view);
    if (!found) throw new SourceError(ErrorCodes.viewNotFound, "The view no longer exists.", 404);
    return found;
  }

  async createView(query: ViewQuery, signal?: AbortSignal): Promise<ViewInfo> {
    const shown = this.current();
    if (isEmptyQuery(query)) return { id: null, rowCount: shown.result.rows.length, query: {} };
    let table = shown.table;
    let rows: ViewQuery = query;
    if (shown.result.truncated) {
      // The first groups of another order are other groups: the base source sorts them.
      const sort = query.sort ?? [];
      const key = JSON.stringify(sort);
      let sorted = this.sorted.get(key);
      if (!sorted) {
        sorted = this.fetch(sort, signal);
        this.sorted.set(key, sorted);
        sorted.catch(() => this.sorted.delete(key));
        for (const old of this.sorted.keys()) {
          if (this.sorted.size <= 4) break;
          this.sorted.delete(old);
        }
      }
      table = (await sorted).table;
      rows = {};
    }
    const created = await table.createView(rows, signal);
    const id = `g${this.nextView++}`;
    this.views.set(id, { table, view: created.id });
    for (const old of this.views.keys()) {
      if (this.views.size <= 8) break;
      this.views.delete(old);
    }
    return { id, rowCount: created.rowCount, query };
  }

  readRows(request: RowRequest): Promise<RowBlock> {
    const { table, view } = this.entry(request.view);
    return table.readRows({ ...request, view });
  }

  columnStats(view: string | null, column: number): Promise<ColumnStats> {
    const entry = this.entry(view);
    return entry.table.columnStats(entry.view, column);
  }

  distinctValues(request: DistinctRequest): Promise<DistinctValues> {
    const { table, view } = this.entry(request.view);
    return table.distinctValues({ ...request, view });
  }

  aggregate(request: AggregateRequest): Promise<SelectionSummary> {
    const { table, view } = this.entry(request.view);
    return table.aggregate({ ...request, view });
  }

  find(request: FindRequest): Promise<FindResult | null> {
    const { table, view } = this.entry(request.view);
    return table.find({ ...request, view });
  }

  exportView(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult> {
    const { table, view } = this.entry(request.view);
    return table.exportView({ ...request, view }, signal);
  }

  group(request: GroupRequest, signal?: AbortSignal): Promise<GroupResult> {
    const { table, view } = this.entry(request.view);
    return table.group({ ...request, view }, signal);
  }

  /** Follows the base source's changes: the groups are read again on the next `info`. */
  subscribe(listener: TableChangeListener): () => void {
    if (!this.base.subscribe) return () => undefined;
    return this.base.subscribe(() => {
      this.shown = null;
      this.loading = null;
      this.sorted.clear();
      this.views.clear();
      this.revision++;
      listener({ revision: String(this.revision) });
    });
  }
}

/** Sorting, the selection summary and find work on the returned groups; the rest needs all of them. */
function capabilitiesOf(ready: boolean, all = false) {
  return {
    sort: ready,
    filter: all,
    search: all,
    stats: all,
    distinct: all,
    aggregate: ready,
    find: ready,
    export: all,
    conditions: all,
    group: all,
  };
}
