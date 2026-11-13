import type { CellActionEvent, DataGridHandle } from "vastgrid";

export interface Bench {
  engine: "main" | "worker";
  rows: number;
  columns: number;
  generatedIn: number;
  mountedAt: number;
  firstRowsAt: number | null;
  commits: { phase: string; duration: number; at: number }[];
  longTasks: number[];
  ready(): boolean;
  scroll(frames: number, step: number): Promise<{ commits: number; frames: number[] }>;
  latencies: number[];
  sort(column: string): Promise<{ ms: number; longestTask: number }>;
  heap(): number | null;
  openTables: Set<string>;
  opens: number;
}

declare global {
  interface Window {
    bench: Bench;
    files: { handle: DataGridHandle | null; actions: CellActionEvent[] };
    host: {
      call(name: string, args: Record<string, unknown>): Promise<unknown>;
      calls: string[];
      setLocale(locale: string): void;
      opened: { structuredContent?: { grid?: string } } | null;
    };
  }
}
