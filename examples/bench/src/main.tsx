import { Profiler, type ProfilerOnRenderCallback } from "react";
import { createRoot } from "react-dom/client";
import { benchTable } from "./data.ts";

/**
 * The bench (v2-react.md §10): `?grid=v1|v2&rows=…&columns=…` mounts one grid on a generated table and gives
 * `window.bench` to the end-to-end tests, which scroll it, press keys and read what React and the frames did.
 */
interface Commit {
  phase: string;
  duration: number;
  at: number;
}

export interface Bench {
  grid: "v1" | "v2";
  /** Where v2's engine runs: in the page, or in a Web Worker. */
  engine: "main" | "worker";
  rows: number;
  columns: number;
  generatedIn: number;
  mountedAt: number;
  firstRowsAt: number | null;
  commits: Commit[];
  longTasks: number[];
  /** Whether the grid has the value of its first cell. */
  ready(): boolean;
  /** Scrolls by `step` pixels for `frames` frames: the gaps between frames, and the commits meanwhile. */
  scroll(frames: number, step: number): Promise<{ commits: number; frames: number[] }>;
  /** The time from each key press to the next frame, since `keys` was armed. */
  latencies: number[];
  /** Sorts by a column and waits until the sorted rows are on screen: the time, and the longest task meanwhile. */
  sort(column: string): Promise<{ ms: number; longestTask: number }>;
  heap(): number | null;
}

declare global {
  interface Window {
    bench: Bench;
  }
}

const params = new URLSearchParams(location.search);
const grid = params.get("grid") === "v1" ? "v1" : "v2";
const engineAt = params.get("engine") === "worker" ? "worker" : "main";
const rows = Number(params.get("rows") ?? 1_000_000);
const columns = Number(params.get("columns") ?? 8);

const started = performance.now();
// A worker makes its own table; the page makes it for v1 and for an engine in the page.
const table = grid === "v2" && engineAt === "worker" ? null : benchTable(rows, columns);

let sortBy: (column: string) => void = () => {};
let isPending: () => boolean = () => false;

const bench: Bench = {
  grid,
  engine: engineAt,
  rows,
  columns,
  generatedIn: performance.now() - started,
  mountedAt: 0,
  firstRowsAt: null,
  commits: [],
  longTasks: [],
  ready: () => false,
  latencies: [],
  heap: () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
  sort(column) {
    const tasks = bench.longTasks.length;
    const begun = performance.now();
    sortBy(column);
    return new Promise((resolve) => {
      const check = () => {
        if (isPending()) {
          requestAnimationFrame(check);
          return;
        }
        // The frame that shows the sorted rows.
        requestAnimationFrame(() => {
          const ms = performance.now() - begun;
          setTimeout(() => resolve({ ms, longestTask: Math.max(0, ...bench.longTasks.slice(tasks)) }), 100);
        });
      };
      requestAnimationFrame(check);
    });
  },
  scroll(frames, step) {
    const scroller = document.querySelector<HTMLElement>(".vg-scroller");
    if (!scroller) throw new Error("There is no scroller.");
    const before = bench.commits.length;
    const gaps: number[] = [];
    return new Promise((resolve) => {
      let count = 0;
      let last = performance.now();
      const tick = (now: number) => {
        gaps.push(now - last);
        last = now;
        if (count++ >= frames) {
          // The commits that the last scroll causes, if any, come within a frame or two.
          setTimeout(() => resolve({ commits: bench.commits.length - before, frames: gaps.slice(1) }), 50);
          return;
        }
        scroller.scrollTop += step;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  },
};
window.bench = bench;

new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) bench.longTasks.push(entry.duration);
}).observe({ type: "longtask", buffered: true });

// Before the grid's own handlers: the time from a key press to the next frame.
addEventListener(
  "keydown",
  (event) => {
    const pressed = event.timeStamp;
    requestAnimationFrame((frame) => bench.latencies.push(frame - pressed));
  },
  { capture: true },
);

const onRender: ProfilerOnRenderCallback = (_id, phase, duration, _base, _start, commitTime) => {
  bench.commits.push({ phase, duration, at: commitTime });
};

function watchFirstRows() {
  if (bench.ready()) {
    requestAnimationFrame(() => {
      bench.firstRowsAt = performance.now();
    });
    return;
  }
  requestAnimationFrame(watchFirstRows);
}

async function main() {
  const element = document.getElementById("root");
  if (!element) throw new Error("There is no #root.");
  const root = createRoot(element);
  if (grid === "v1") {
    await import("vastgrid/styles.css");
    const { ArraySource, DataGrid } = await import("vastgrid");
    if (!table) throw new Error("v1 makes its table in the page.");
    const source = new ArraySource({ columns: table.columns, columnData: table.columnData });
    let handle: {
      controller: { cache: { value(row: number, column: number): unknown }; viewPending: boolean };
      setQuery(query: { sort: { column: number; direction: "asc" | "desc" }[] }): void;
    } | null = null;
    bench.ready = () => handle?.controller.cache.value(0, 0) !== undefined;
    sortBy = (column) => {
      const index = table.columns.findIndex((item) => item.name === column);
      handle?.setQuery({ sort: [{ column: index, direction: "asc" }] });
    };
    isPending = () => handle?.controller.viewPending ?? false;
    bench.mountedAt = performance.now();
    root.render(
      <Profiler id="grid" onRender={onRender}>
        <DataGrid
          ref={(value) => {
            handle = value as typeof handle;
          }}
          source={source}
          style={{ height: "100%" }}
        />
      </Profiler>,
    );
  } else {
    await import("vastgrid-grid/styles.css");
    const { DataGrid, localTransport, workerTransport } = await import("vastgrid-grid");
    let transport: Parameters<typeof DataGrid>[0]["transport"];
    if (table) {
      const { memoryEngine } = await import("vastgrid-js");
      const engine = memoryEngine({
        tables: {
          bench: {
            columns: table.columns.map((column) => (column.type === "float" ? { ...column, bits: 64 } : column)),
            rows: table.rowData,
          },
        },
      });
      transport = localTransport(engine);
    } else {
      const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
      await new Promise<void>((resolve) => {
        worker.addEventListener("message", function ready(event) {
          if ((event.data as { ready?: boolean }).ready !== true) return;
          worker.removeEventListener("message", ready);
          resolve();
        });
        worker.postMessage({ init: { rows, columns } });
      });
      transport = workerTransport(worker);
    }
    let handle: import("vastgrid-grid").DataGridHandle | null = null;
    bench.ready = () => handle?.store.cell(0, "id") !== undefined;
    sortBy = (column) => {
      void handle?.dispatch({ command: "sort.set", keys: [{ column, direction: "asc" }] });
    };
    isPending = () => handle?.store.getSnapshot().pending !== null;
    bench.mountedAt = performance.now();
    root.render(
      <Profiler id="grid" onRender={onRender}>
        <DataGrid
          ref={(value) => {
            handle = value;
          }}
          transport={transport}
          table="bench"
          locale="en"
          style={{ height: "100%" }}
        />
      </Profiler>,
    );
  }
  requestAnimationFrame(watchFirstRows);
}

void main();
